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
    let rule:[String:Any], definitions:[String:[String:Any]], policyName:String
    init(version:Int) throws {
        let url = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("appliance/manifest.schema.json")
        let data = try Data(contentsOf:url)
        guard data.count <= 65536, let s = try JSONSerialization.jsonObject(with:data) as? [String:Any],
              Set(s.keys) == Set(["schemaVersion","maxBytes","maxDepth","definitions","inputManifest","applianceManifest","legacyInputManifest","legacyApplianceManifest"]),
              s["schemaVersion"] as? Int == 2, s["maxBytes"] as? Int == 65536, s["maxDepth"] as? Int == 8,
              [1,2].contains(version),
              let definitions = s["definitions"] as? [String:[String:Any]], Set(definitions.keys) == Set(["identity","policy","legacyIdentity","legacyPolicy"]),
              let rule = s[version == 1 ? "legacyApplianceManifest":"applianceManifest"] as? [String:Any] else { throw ApplianceFailure.invalidManifest }
        self.rule = rule; self.definitions = definitions; policyName = version == 1 ? "legacyPolicy":"policy"
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
            guard data.count <= 65536,
                  let header = try JSONSerialization.jsonObject(with:data) as? [String:Any],
                  let version = header["manifestVersion"] as? NSNumber,
                  CFGetTypeID(version) != CFBooleanGetTypeID(), [1.0,2.0].contains(version.doubleValue) else { throw ApplianceFailure.invalidManifest }
            // This lookahead selects a frozen descriptor only; the strict M1 scanner
            // below still rejects duplicates, exponents and noncanonical integers.
            let schema = try ApplianceSchema(version:version.intValue); var wire = schema.rule, fields = wire["fields"] as! [String:[String:Any]]
            fields["architecture"] = ["type":"string","pattern":"[A-Za-z0-9_]+","max":32]
            fields["policy"] = schema.shape(schema.definitions[schema.policyName]!); wire["fields"] = fields
            let value = try Contracts.decodeDocument(data,rule:wire,definitions:schema.definitions,maxBytes:65536)
            guard value["architecture"] as? String == "aarch64" else { throw ApplianceFailure.architecture }
            let policy = value["policy"] as! [String:Any]
            do { _ = try Contracts.canonicalDocument(policy,rule:schema.definitions[schema.policyName]!,definitions:schema.definitions,maxBytes:65536) }
            catch { throw ApplianceFailure.policy }
            let features = (version.intValue == 2 ? ["CONFIG_AUDIT","CONFIG_AUDITSYSCALL","CONFIG_INOTIFY_USER"]:[]) + ["CONFIG_NAMESPACES","CONFIG_PID_NS","CONFIG_SECCOMP","CONFIG_SECCOMP_FILTER","CONFIG_TMPFS","CONFIG_USER_NS","CONFIG_VIRTIO","CONFIG_VIRTIO_BLK","CONFIG_VIRTIO_CONSOLE","CONFIG_VIRTIO_VSOCKETS","CONFIG_VSOCKETS"]
            guard policy["kernelFeatures"] as? [String] == features else { throw ApplianceFailure.kernelFeature }
            let components = value["components"] as! [[String:Any]], ids = components.map { $0["id"] as! String }
            let base:Set<String> = ["rootfs","kernel","initramfs","kernelConfig","node","python","playwright","chromium","hostLauncher","hostBroker","contracts"]
            var payload:Set<String> = ["guestBootstrap","controller","proxy","verifier","rolePolicy","seccompPolicy","routePolicy","guestProbes"]
            if version.intValue == 2 { payload.insert("browserWorker") }
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
    var version:Int { value["manifestVersion"] as! Int }
    fileprivate var document:[String:Any] { value }
    func requireComposition() throws {
        guard version == 2 else { throw ApplianceFailure.qualificationUnavailable }
        guard value["payloadState"] as? String == "COMPLETE" else { throw ApplianceFailure.payloadIncomplete }
    }
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
        s.st_dev == original.st_dev && s.st_ino == original.st_ino && s.st_size == original.st_size && s.st_mode == original.st_mode && s.st_uid == original.st_uid && s.st_gid == original.st_gid && s.st_nlink == 1 && s.st_mtimespec.tv_sec == original.st_mtimespec.tv_sec && s.st_mtimespec.tv_nsec == original.st_mtimespec.tv_nsec && s.st_ctimespec.tv_sec == original.st_ctimespec.tv_sec && s.st_ctimespec.tv_nsec == original.st_ctimespec.tv_nsec
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
    func checkSafe() throws {
        guard original.st_mode & 0o7022 == 0 else { throw ApplianceFailure.artifactMismatch }
        try check()
    }
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
    fileprivate func recheckPopulationBase() throws { try recheck(); try artifacts["base"]!.checkSafe() }
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

// Wire inventories describe planned installation. Neither a wire document nor
// byte equality supplies the missing original native population authority.
struct ExecutableMemberRecord: Sendable, Equatable {
    let componentID:String, artifactSHA256:String, memberPath:String, memberSHA256:String, sizeBytes:Int, installedPath:String
}
final class ValidatedExecutableMembers: @unchecked Sendable {
    let manifestDigest:String, records:[ExecutableMemberRecord]
    fileprivate let origin:OfflineInstalledExecutableInventory
    private let snapshots:[String:Data]
    private init(manifest:ApplianceManifest,records:[ExecutableMemberRecord],snapshots:[String:Data],origin:OfflineInstalledExecutableInventory) {
        manifestDigest=manifest.digest; self.records=records; self.snapshots=snapshots; self.origin=origin
    }
    // Explicit inert byte validation only. Archive membership was established by
    // the Python producer; transported rows cannot confer its nominal authority.
    // This path never constructs InstalledExecutableInventory.
    fileprivate static func offline(manifest:ApplianceManifest,records:[ExecutableMemberRecord],bytes:[String:Data],origin:OfflineInstalledExecutableInventory) throws -> ValidatedExecutableMembers {
        guard Set(bytes.keys) == Set(records.map(\.installedPath)) else { throw ApplianceFailure.artifactMismatch }
        for row in records {
            guard let data=bytes[row.installedPath], data.count == row.sizeBytes,
                  applianceHash(data) == row.memberSHA256 else { throw ApplianceFailure.artifactMismatch }
        }
        return ValidatedExecutableMembers(manifest:manifest,records:records,snapshots:bytes,origin:origin)
    }
    fileprivate func recheck() throws {
        for row in records {
            guard let data=snapshots[row.installedPath], data.count == row.sizeBytes,
                  applianceHash(data) == row.memberSHA256 else { throw ApplianceFailure.inputChanged }
        }
    }
}

final class InstalledExecutableInventory: @unchecked Sendable {
    // No native population adapter/factory exists. A future reviewed adapter must
    // establish original input/member/base/population ownership before it can
    // call this private initializer; a hash getter cannot implement this type.
    private let members:ValidatedExecutableMembers, appliance:ArtifactVerifiedAppliance
    private let installed:[String:RetainedArtifact]
    private init(members:ValidatedExecutableMembers,appliance:ArtifactVerifiedAppliance,installed:[String:RetainedArtifact]) {
        self.members=members; self.appliance=appliance; self.installed=installed
    }
    static func requireNative(_ value:Any) throws -> InstalledExecutableInventory {
        guard let inventory=value as? InstalledExecutableInventory else { throw ApplianceFailure.qualificationUnavailable }
        return inventory
    }
    func pins(manifest:ApplianceManifest) throws -> [String:String] {
        try manifest.requireComposition()
        guard manifest.digest == appliance.manifest.digest, manifest.digest == members.manifestDigest,
              (manifest.document["provenance"] as! [String:Any])["assemblyMode"] as? String == "NATIVE_ARM64_LINUX" else { throw ApplianceFailure.identityMismatch }
        try members.recheck(); try appliance.recheckPopulationBase()
        guard Set(installed.keys) == Set(members.records.map(\.installedPath)) else { throw ApplianceFailure.artifactMismatch }
        for row in members.records {
            guard let owner=installed[row.installedPath], owner.hash == row.memberSHA256, owner.size == row.sizeBytes else { throw ApplianceFailure.artifactMismatch }
            try owner.checkSafe()
        }
        try members.recheck(); try appliance.recheckPopulationBase()
        return Dictionary(uniqueKeysWithValues:members.records.map { ($0.installedPath,$0.memberSHA256) })
    }
}

final class OfflineInstalledExecutableInventory: @unchecked Sendable {
    let records:[ExecutableMemberRecord], manifestDigest:String
    private let appliance:ArtifactVerifiedAppliance
    private let installed:[String:RetainedArtifact]
    private let retainedMembers:ValidatedExecutableMembers?
    private init(records:[ExecutableMemberRecord],appliance:ArtifactVerifiedAppliance,installed:[String:RetainedArtifact] = [:],members:ValidatedExecutableMembers? = nil) {
        self.records=records; self.appliance=appliance; manifestDigest=appliance.manifest.digest
        self.installed=installed; retainedMembers=members
    }
    static let mapping:[(String,String,String)] = [
        ("browserWorker","","/opt/acceptance/guest/browser-worker.cjs"),
        ("chromium","chrome","/opt/acceptance/runtime/chromium/chrome"),
        ("controller","","/opt/acceptance/guest/controller.cjs"),
        ("node","bin/node","/opt/acceptance/runtime/node/bin/node"),
        ("proxy","","/opt/acceptance/guest/proxy.py"),
        ("python","bin/python3","/opt/acceptance/runtime/python/bin/python3"),
        ("verifier","","/opt/acceptance/guest/verifier.cjs")
    ]
    static func decode(_ data:Data,appliance:ArtifactVerifiedAppliance) throws -> OfflineInstalledExecutableInventory {
        do {
            let manifest=appliance.manifest; try manifest.requireComposition(); try appliance.recheck()
            let schema=try ApplianceSchema(version:2)
            let hash:[String:Any]=["type":"string","pattern":"[a-f0-9]{64}","max":64]
            let string:[String:Any]=["type":"string","pattern":"[ -~]*","max":128]
            let member:[String:Any]=["type":"object","fields":["componentId":string,"artifactSHA256":hash,"memberPath":string,
                "memberSHA256":hash,"sizeBytes":["type":"integer","min":Int64(1),"max":Int64(68719476736)],"installedPath":string]]
            let rule:[String:Any]=["type":"object","fields":["inventoryVersion":["type":"enum","values":[1]],
                "inputsDigest":hash,"manifestDigest":hash,"baseIdentity":["ref":"identity"],
                "populationState":["type":"enum","values":["UNPERFORMED"]],"members":["type":"array","item":member,"min":7,"max":7]]]
            let document=try Contracts.decodeDocument(data,rule:rule,definitions:schema.definitions,maxBytes:65536)
            let original=manifest.document
            guard document["manifestDigest"] as? String == manifest.digest,
                  document["inputsDigest"] as? String == original["inputsDigest"] as? String,
                  NSDictionary(dictionary:document["baseIdentity"] as! [String:Any]).isEqual(to:(original["outputs"] as! [[String:Any]])[0]) else { throw ApplianceFailure.identityMismatch }
            guard (original["provenance"] as! [String:Any])["assemblyMode"] as? String == "SYNTHETIC" else { throw ApplianceFailure.syntheticOnly }
            let components=original["components"] as! [[String:Any]], rows=document["members"] as! [[String:Any]]
            var records:[ExecutableMemberRecord]=[]
            for (row,expected) in zip(rows,mapping) {
                guard row["componentId"] as? String == expected.0, row["memberPath"] as? String == expected.1,
                      row["installedPath"] as? String == expected.2,
                      let component=components.first(where:{ $0["id"] as? String == expected.0 }),
                      row["artifactSHA256"] as? String == component["sha256"] as? String else { throw ApplianceFailure.artifactMismatch }
                if expected.1.isEmpty {
                    guard row["memberSHA256"] as? String == component["sha256"] as? String,
                          row["sizeBytes"] as? Int == component["sizeBytes"] as? Int else { throw ApplianceFailure.artifactMismatch }
                }
                records.append(ExecutableMemberRecord(componentID:expected.0,artifactSHA256:row["artifactSHA256"] as! String,
                    memberPath:expected.1,memberSHA256:row["memberSHA256"] as! String,sizeBytes:row["sizeBytes"] as! Int,installedPath:expected.2))
            }
            try appliance.recheck()
            return OfflineInstalledExecutableInventory(records:records,appliance:appliance)
        } catch let failure as ApplianceFailure { throw failure } catch { throw ApplianceFailure.invalidManifest }
    }
    func validateMemberBytes(_ bytes:[String:Data]) throws -> ValidatedExecutableMembers {
        try appliance.recheck()
        let members=try ValidatedExecutableMembers.offline(manifest:appliance.manifest,records:records,bytes:bytes,origin:self)
        try appliance.recheck(); return members
    }
    // Exercises the shared retained-byte/population contract with inert files;
    // even complete byte equality returns this separately typed offline result.
    func observeOfflinePopulation(members:ValidatedExecutableMembers,originalBase:ArtifactVerifiedAppliance,installedLocations:[String:URL]) throws -> OfflineInstalledExecutableInventory {
        guard originalBase === appliance, members.origin === self, members.manifestDigest == manifestDigest, members.records == records else { throw ApplianceFailure.identityMismatch }
        guard Set(installedLocations.keys) == Set(records.map(\.installedPath)) else { throw ApplianceFailure.artifactMismatch }
        try members.recheck(); try appliance.recheckPopulationBase()
        var retained:[String:RetainedArtifact]=[:]
        for row in records {
            let owner=try RetainedArtifact(url:installedLocations[row.installedPath]!,hash:row.memberSHA256,size:row.sizeBytes)
            try owner.checkSafe(); retained[row.installedPath]=owner
        }
        try members.recheck(); try appliance.recheckPopulationBase()
        for owner in retained.values { try owner.checkSafe() }
        return OfflineInstalledExecutableInventory(records:records,appliance:appliance,installed:retained,members:members)
    }
    func recheck() throws {
        try appliance.recheck(); try retainedMembers?.recheck()
        if retainedMembers != nil { try appliance.recheckPopulationBase() }
        for owner in installed.values { try owner.checkSafe() }
    }
}
