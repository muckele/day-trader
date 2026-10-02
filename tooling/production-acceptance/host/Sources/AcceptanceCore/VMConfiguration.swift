import Foundation
import CoreFoundation
import CryptoKit
import Darwin
import Virtualization

public enum ApplianceFailure: String, Error, Sendable {
    case invalidManifest = "INVALID_MANIFEST", identityMismatch = "IDENTITY_MISMATCH", artifactMismatch = "ARTIFACT_MISMATCH", inputChanged = "INPUT_CHANGED", architecture = "ARCHITECTURE", kernelFeature = "KERNEL_FEATURE", policy = "POLICY", missingRuntime = "MISSING_RUNTIME", payloadIncomplete = "PAYLOAD_INCOMPLETE", unauthorizedInput = "UNAUTHORIZED_INPUT", syntheticOnly = "SYNTHETIC_ONLY", signingUnavailable = "SIGNING_UNAVAILABLE", qualificationUnavailable = "QUALIFICATION_UNAVAILABLE"
}
func applianceHash(_ data: Data) -> String { SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined() }

private struct ApplianceSchema {
    let rule:[String:Any], definitions:[String:[String:Any]]
    init() throws {
        let url = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("appliance/manifest.schema.json")
        let data = try Data(contentsOf:url)
        guard data.count <= 65536, let s = try JSONSerialization.jsonObject(with:data) as? [String:Any],
              Set(s.keys) == Set(["schemaVersion","maxBytes","maxDepth","definitions","inputManifest","applianceManifest"]),
              s["schemaVersion"] as? Int == 1, s["maxBytes"] as? Int == 65536, s["maxDepth"] as? Int == 8,
              let definitions = s["definitions"] as? [String:[String:Any]], Set(definitions.keys) == Set(["identity","policy"]),
              let rule = s["applianceManifest"] as? [String:Any] else { throw ApplianceFailure.invalidManifest }
        self.rule = rule; self.definitions = definitions
    }
    // Type-only policy stage preserves finite semantic error codes. The complete trusted
    // descriptor is always applied before returning the immutable decoded value.
    func shape(_ rule:[String:Any]) -> [String:Any] {
        switch rule["type"] as? String {
        case "object": return ["type":"object","fields":(rule["fields"] as! [String:[String:Any]]).mapValues(shape)]
        case "array": var r = rule; r["item"] = shape(rule["item"] as! [String:Any]); return r
        case "integer": return ["type":"integer","min":Int64(0),"max":9007199254740991 as Int64]
        case "enum":
            let value = (rule["values"] as! [Any])[0]
            if let number = value as? NSNumber { return CFGetTypeID(number) == CFBooleanGetTypeID() ? ["type":"boolean"] : ["type":"integer","min":Int64(0),"max":9007199254740991 as Int64] }
            return ["type":"string","pattern":"[ -~]*","max":256]
        default: return rule
        }
    }
}
// The only initializer is the successful strict decoder. JSON containers are private
// immutable value copies; callers cannot mutate an admitted manifest through aliases.
public struct ApplianceManifest: @unchecked Sendable {
    private let value:[String:Any], canonical:Data
    private init(value:[String:Any],canonical:Data) { self.value = value; self.canonical = canonical }
    public static func decode(_ data: Data) throws -> Self {
        do {
            let schema = try ApplianceSchema(); var wire = schema.rule, fields = wire["fields"] as! [String:[String:Any]]
            fields["architecture"] = ["type":"string","pattern":"[A-Za-z0-9_]+","max":32]
            fields["policy"] = schema.shape(schema.definitions["policy"]!); wire["fields"] = fields
            let value = try Contracts.decodeDocument(data,rule:wire,definitions:schema.definitions,maxBytes:65536)
            guard value["architecture"] as? String == "aarch64" else { throw ApplianceFailure.architecture }
            let policy = value["policy"] as! [String:Any]
            do { _ = try Contracts.canonicalDocument(policy,rule:schema.definitions["policy"]!,definitions:schema.definitions,maxBytes:65536) }
            catch { throw ApplianceFailure.policy }
            let features = ["CONFIG_NAMESPACES","CONFIG_PID_NS","CONFIG_SECCOMP","CONFIG_SECCOMP_FILTER","CONFIG_TMPFS","CONFIG_USER_NS","CONFIG_VIRTIO","CONFIG_VIRTIO_BLK","CONFIG_VIRTIO_CONSOLE","CONFIG_VIRTIO_VSOCKETS","CONFIG_VSOCKETS"]
            guard policy["kernelFeatures"] as? [String] == features else { throw ApplianceFailure.kernelFeature }
            let components = value["components"] as! [[String:Any]], ids = components.map { $0["id"] as! String }
            let base:Set<String> = ["rootfs","kernel","initramfs","kernelConfig","node","python","playwright","chromium","hostLauncher","hostBroker","contracts"]
            let payload:Set<String> = ["guestBootstrap","controller","proxy","verifier","rolePolicy","seccompPolicy","routePolicy","guestProbes"]
            guard ids == Set(ids).sorted(), Set(ids).isSubset(of:base.union(payload)) else { throw ApplianceFailure.unauthorizedInput }
            guard Set(["node","python","playwright","chromium"]).isSubset(of:Set(ids)) else { throw ApplianceFailure.missingRuntime }
            guard base.isSubset(of:Set(ids)) else { throw ApplianceFailure.unauthorizedInput }
            let missing = payload.subtracting(ids).sorted()
            guard value["missingPayload"] as? [String] == missing, value["payloadState"] as? String == (missing.isEmpty ? "COMPLETE":"INCOMPLETE") else { throw ApplianceFailure.payloadIncomplete }
            let provenance = value["provenance"] as! [String:Any], tools = provenance["tools"] as! [[String:Any]], outputs = value["outputs"] as! [[String:Any]]
            guard tools.map({ $0["id"] as! String }) == ["mke2fs"], outputs.map({ $0["id"] as! String }) == ["base","initramfs","kernel"] else { throw ApplianceFailure.unauthorizedInput }
            for output in outputs.dropFirst() {
                guard let input = components.first(where: { $0["id"] as? String == output["id"] as? String }), NSDictionary(dictionary:input).isEqual(to:output) else { throw ApplianceFailure.artifactMismatch }
            }
            let canonical = try Contracts.canonicalDocument(value,rule:schema.rule,definitions:schema.definitions,maxBytes:65536)
            return Self(value:value,canonical:canonical)
        } catch let error as ApplianceFailure { throw error } catch { throw ApplianceFailure.invalidManifest }
    }
    public func canonicalBytes() throws -> Data { canonical }
    public var digest: String { applianceHash(canonical) }
    public var runtimeBlockers: [ApplianceFailure] {
        var reasons:[ApplianceFailure] = []
        if value["payloadState"] as? String != "COMPLETE" { reasons.append(.payloadIncomplete) }
        if (value["provenance"] as! [String:Any])["assemblyMode"] as? String == "SYNTHETIC" { reasons.append(.syntheticOnly) }
        return reasons + [.signingUnavailable,.qualificationUnavailable]
    }
    var resources:[String:Int] { (value["policy"] as! [String:Any])["resources"] as! [String:Int] }
    public func verifyArtifacts(locations:[String:URL],expectedManifestDigest:String) throws -> ArtifactVerifiedAppliance {
        guard expectedManifestDigest == digest else { throw ApplianceFailure.identityMismatch }
        guard Set(locations.keys) == Set(["base","initramfs","kernel"]) else { throw ApplianceFailure.artifactMismatch }
        var artifacts:[String:RetainedArtifact] = [:]
        for row in value["outputs"] as! [[String:Any]] {
            let id = row["id"] as! String
            artifacts[id] = try RetainedArtifact(url:locations[id]!,hash:row["sha256"] as! String,size:row["sizeBytes"] as! Int)
        }
        return ArtifactVerifiedAppliance(manifest:self,artifacts:artifacts)
    }
}

// Retain regular artifact handles and stream their hashes. Neither native VZ attachments
// nor whole-file allocations up to the 64 GiB document ceiling occur here.
private final class RetainedArtifact: @unchecked Sendable {
    let url:URL, hash:String, size:Int
    private var fd:Int32 = -1
    private let lock = NSLock()
    private var original = stat()
    init(url:URL,hash:String,size:Int) throws {
        self.url = url; self.hash = hash; self.size = size
        guard url.isFileURL else { throw ApplianceFailure.artifactMismatch }
        fd = Darwin.open(url.path,O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        do {
            guard fd >= 0, fstat(fd,&original) == 0, original.st_mode & S_IFMT == S_IFREG, original.st_nlink == 1, original.st_size == size else { throw ApplianceFailure.artifactMismatch }
            try check()
        } catch { if fd >= 0 { _ = Darwin.close(fd); fd = -1 }; throw ApplianceFailure.artifactMismatch }
    }
    deinit { if fd >= 0 { _ = Darwin.close(fd) } }
    private func same(_ s:stat) -> Bool {
        s.st_dev == original.st_dev && s.st_ino == original.st_ino && s.st_size == original.st_size && s.st_mode == original.st_mode && s.st_nlink == 1 && s.st_mtimespec.tv_sec == original.st_mtimespec.tv_sec && s.st_mtimespec.tv_nsec == original.st_mtimespec.tv_nsec && s.st_ctimespec.tv_sec == original.st_ctimespec.tv_sec && s.st_ctimespec.tv_nsec == original.st_ctimespec.tv_nsec
    }
    private func consume(capture:Bool) throws -> Data {
        var observed = stat(), path = stat()
        guard fstat(fd,&observed) == 0, same(observed), lstat(url.path,&path) == 0, same(path) else { throw ApplianceFailure.inputChanged }
        var hasher = SHA256(), result = Data(), offset = 0, buffer = [UInt8](repeating:0,count:65536)
        while offset < size {
            let count = buffer.withUnsafeMutableBytes { pread(fd,$0.baseAddress!,min($0.count,size-offset),off_t(offset)) }
            guard count > 0 else { throw ApplianceFailure.inputChanged }
            let chunk = Data(buffer.prefix(count)); hasher.update(data:chunk); if capture { result.append(chunk) }; offset += count
        }
        guard hasher.finalize().map({ String(format:"%02x",$0) }).joined() == hash,
              fstat(fd,&observed) == 0, same(observed), lstat(url.path,&path) == 0, same(path) else { throw ApplianceFailure.inputChanged }
        return result
    }
    func check() throws { try lock.withLock { _ = try consume(capture:false) } }
    func bytes() throws -> Data {
        // Explicit small inspection/relay input capture, never used for native attachment.
        guard size <= 16 * 1024 * 1024 else { throw ApplianceFailure.unauthorizedInput }
        return try lock.withLock { try consume(capture:true) }
    }
}

public final class ArtifactVerifiedAppliance: @unchecked Sendable {
    public let manifest:ApplianceManifest
    private let artifacts:[String:RetainedArtifact]
    fileprivate init(manifest:ApplianceManifest,artifacts:[String:RetainedArtifact]) { self.manifest = manifest; self.artifacts = artifacts }
    public func recheck() throws { for id in artifacts.keys.sorted() { try artifacts[id]!.check() } }
    public func artifactBytes(_ id:String) throws -> Data { guard let artifact = artifacts[id] else { throw ApplianceFailure.artifactMismatch }; return try artifact.bytes() }
    // Fixed policy projection: a complete plan, but deliberately incomplete VZ object
    // until a future admitted adapter supplies read-only base and private serial handles.
    public var plan: VMConfigurationPlan { VMConfigurationPlan(manifest:manifest) }
    public func inspectionConfiguration() throws -> VZVirtualMachineConfiguration {
        try recheck(); let p = plan
        try p.validateResources()
        let c = VZVirtualMachineConfiguration(), boot = VZLinuxBootLoader(kernelURL:artifacts["kernel"]!.url)
        boot.initialRamdiskURL = artifacts["initramfs"]!.url; boot.commandLine = VMConfigurationPlan.bootCommandLine
        c.bootLoader = boot; c.platform = VZGenericPlatformConfiguration(); c.cpuCount = p.cpuCount; c.memorySize = p.memoryBytes
        c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]; c.serialPorts = [VZVirtioConsoleDeviceSerialPortConfiguration()]; c.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        c.storageDevices = []; c.networkDevices = []; c.directorySharingDevices = []; c.consoleDevices = []; c.audioDevices = []; c.graphicsDevices = []; c.keyboards = []; c.pointingDevices = []; c.memoryBalloonDevices = []
        if #available(macOS 15,*) { c.usbControllers = [] }
        if #available(macOS 27,*) { c.customVirtioDevices = []; c.label = nil }
        try inspect(c); return c
    }
    public func inspect(_ c:VZVirtualMachineConfiguration) throws {
        try recheck(); try plan.validateResources()
        guard type(of:c) == VZVirtualMachineConfiguration.self, type(of:c.platform) == VZGenericPlatformConfiguration.self,
              let boot = c.bootLoader as? VZLinuxBootLoader, type(of:boot) == VZLinuxBootLoader.self,
              boot.kernelURL == artifacts["kernel"]!.url, boot.initialRamdiskURL == artifacts["initramfs"]!.url, boot.commandLine == VMConfigurationPlan.bootCommandLine,
              c.cpuCount == plan.cpuCount, c.memorySize == plan.memoryBytes,
              c.networkDevices.isEmpty, c.directorySharingDevices.isEmpty, c.consoleDevices.isEmpty, c.audioDevices.isEmpty, c.graphicsDevices.isEmpty, c.keyboards.isEmpty, c.pointingDevices.isEmpty, c.memoryBalloonDevices.isEmpty, c.storageDevices.isEmpty,
              c.entropyDevices.count == 1, type(of:c.entropyDevices[0]) == VZVirtioEntropyDeviceConfiguration.self,
              c.serialPorts.count == 1, type(of:c.serialPorts[0]) == VZVirtioConsoleDeviceSerialPortConfiguration.self, c.serialPorts[0].attachment == nil,
              c.socketDevices.count == 1, type(of:c.socketDevices[0]) == VZVirtioSocketDeviceConfiguration.self else { throw ApplianceFailure.policy }
        if #available(macOS 15,*) { guard c.usbControllers.isEmpty else { throw ApplianceFailure.policy } }
        if #available(macOS 27,*) { guard c.customVirtioDevices.isEmpty, c.label == nil else { throw ApplianceFailure.policy } }
    }
}
public struct VMConfigurationPlan: Sendable, Equatable {
    public let manifestDigest:String, cpuCount:Int, memoryBytes:UInt64
    public let readOnlyBase = true, privateSerial = true, socketPort:UInt32 = 4050, hostCID:UInt32 = 2
    public let writableDisks = 0, networkDevices = 0, hostTCPListeners = 0, saveRestore = false
    static let bootCommandLine = "console=hvc0 root=/dev/vda ro"
    fileprivate init(manifest:ApplianceManifest) { manifestDigest = manifest.digest; cpuCount = manifest.resources["cpuCount"]!; memoryBytes = UInt64(manifest.resources["memoryBytes"]!) }
    func validateResources() throws {
        guard cpuCount >= VZVirtualMachineConfiguration.minimumAllowedCPUCount, cpuCount <= VZVirtualMachineConfiguration.maximumAllowedCPUCount,
              memoryBytes % 1048576 == 0, memoryBytes >= VZVirtualMachineConfiguration.minimumAllowedMemorySize, memoryBytes <= VZVirtualMachineConfiguration.maximumAllowedMemorySize else { throw ApplianceFailure.policy }
    }
}
