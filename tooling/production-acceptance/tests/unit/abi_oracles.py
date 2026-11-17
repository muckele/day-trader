"""Independent literal oracles for Linux 6.8 AArch64 ABI values.

Transcribed by hand from header text streamed out of the retained archive
(SHA-256 c969dea4e8bb6be991bbf7c010ba0e0a5643a3a8d8fb0a2aaa053406f1e965f3),
without reference to the derived coverage file or the deriver.
"""

ORACLES = {
    '__NR_mknodat': 33,  # linux-6.8/include/uapi/asm-generic/unistd.h:103 #define __NR_mknodat 33
    '__NR_umount2': 39,  # unistd.h:120 #define __NR_umount2 39
    '__NR_mount': 40,  # unistd.h:122 #define __NR_mount 40
    '__NR_pivot_root': 41,  # unistd.h:124 #define __NR_pivot_root 41
    '__NR_chroot': 51,  # unistd.h:148 #define __NR_chroot 51
    '__NR_write': 64,  # unistd.h:174 #define __NR_write 64
    '__NR_capset': 91,  # unistd.h:254 #define __NR_capset 91
    '__NR_unshare': 97,  # unistd.h:266 #define __NR_unshare 97
    '__NR_ptrace': 117,  # unistd.h:329 #define __NR_ptrace 117
    '__NR_setregid': 143,  # unistd.h:394 #define __NR_setregid 143
    '__NR_setgid': 144,  # unistd.h:396 #define __NR_setgid 144
    '__NR_setreuid': 145,  # unistd.h:398 #define __NR_setreuid 145
    '__NR_setuid': 146,  # unistd.h:400 #define __NR_setuid 146
    '__NR_setresuid': 147,  # unistd.h:402 #define __NR_setresuid 147
    '__NR_setresgid': 149,  # unistd.h:406 #define __NR_setresgid 149
    '__NR_setfsuid': 151,  # unistd.h:410 #define __NR_setfsuid 151
    '__NR_setfsgid': 152,  # unistd.h:412 #define __NR_setfsgid 152
    '__NR_setgroups': 159,  # unistd.h:426 #define __NR_setgroups 159
    '__NR_prctl': 167,  # unistd.h:447 #define __NR_prctl 167
    '__NR_socket': 198,  # unistd.h:522 #define __NR_socket 198
    '__NR_socketpair': 199,  # unistd.h:524 #define __NR_socketpair 199
    '__NR_connect': 203,  # unistd.h:532 #define __NR_connect 203
    '__NR_sendto': 206,  # unistd.h:538 #define __NR_sendto 206
    '__NR_setns': 268,  # unistd.h:653 #define __NR_setns 268
    '__NR_process_vm_readv': 270,  # unistd.h:657 #define __NR_process_vm_readv 270
    '__NR_process_vm_writev': 271,  # unistd.h:659 #define __NR_process_vm_writev 271
    '__NR_seccomp': 277,  # unistd.h:671 #define __NR_seccomp 277
    '__NR_io_uring_setup': 425,  # unistd.h:759 #define __NR_io_uring_setup 425
    '__NR_io_uring_enter': 426,  # unistd.h:761 #define __NR_io_uring_enter 426
    '__NR_io_uring_register': 427,  # unistd.h:763 #define __NR_io_uring_register 427
    '__NR_pidfd_open': 434,  # unistd.h:777 #define __NR_pidfd_open 434
    '__NR_close_range': 436,  # unistd.h:785 #define __NR_close_range 436
    '__NR_pidfd_getfd': 438,  # unistd.h:789 #define __NR_pidfd_getfd 438
    '__NR_fcntl': 25,  # unistd.h:859 #define __NR_fcntl __NR3264_fcntl; __NR3264_fcntl is 25 at unistd.h:87
    'SECCOMP_MODE_FILTER': 2,  # linux-6.8/include/uapi/linux/seccomp.h:12 #define SECCOMP_MODE_FILTER 2
    'SECCOMP_SET_MODE_FILTER': 1,  # seccomp.h:16 #define SECCOMP_SET_MODE_FILTER 1
    'SECCOMP_FILTER_FLAG_TSYNC': 1,  # seccomp.h:21 (1UL << 0) = 1
    'SECCOMP_RET_KILL_PROCESS': 0x80000000,  # seccomp.h:38
    'SECCOMP_RET_ERRNO': 0x00050000,  # seccomp.h:42
    'SECCOMP_RET_ALLOW': 0x7fff0000,  # seccomp.h:46
    'seccomp_data.nr': 0,  # seccomp.h:63 struct seccomp_data { int nr; } first field, offset 0
    'seccomp_data.arch': 4,  # seccomp.h:64 __u32 arch after 4-byte int, offset 4
    'seccomp_data.args': 16,  # seccomp.h:66 __u64 args[6]; instruction_pointer (u64, align 8) at 8..16, so args at 16
    'seccomp_data.sizeof': 64,  # seccomp.h:62-67 16 + 6*8 = 64, already 8-aligned
    'EPERM': 1,  # linux-6.8/include/uapi/asm-generic/errno-base.h:5 #define EPERM 1
    'AUDIT_ARCH_AARCH64': 0xC00000B7,  # linux-6.8/include/uapi/linux/audit.h:388 (EM_AARCH64|__AUDIT_ARCH_64BIT|__AUDIT_ARCH_LE) = 183 | 0x80000000 | 0x40000000 (audit.h:385-386); 183 = 0xB7
    'EM_AARCH64': 183,  # linux-6.8/include/uapi/linux/elf-em.h:46 #define EM_AARCH64 183
    'BPF_LD': 0x00,  # linux-6.8/include/uapi/linux/bpf_common.h:7
    'BPF_ALU': 0x04,  # bpf_common.h:11
    'BPF_JMP': 0x05,  # bpf_common.h:12
    'BPF_RET': 0x06,  # bpf_common.h:13
    'BPF_W': 0x00,  # bpf_common.h:18
    'BPF_ABS': 0x20,  # bpf_common.h:24
    'BPF_AND': 0x50,  # bpf_common.h:37
    'BPF_JEQ': 0x10,  # bpf_common.h:45
    'BPF_K': 0x00,  # bpf_common.h:50
    'sock_filter.sizeof': 8,  # linux-6.8/include/uapi/linux/filter.h:24-29 u16+u8+u8+u32 = 2+1+1+4 = 8, alignment 4
    'sock_filter.code': 0,  # filter.h:25 __u16 code, first field, offset 0
    'sock_filter.jt': 2,  # filter.h:26 __u8 jt after 2-byte code, offset 2
    'sock_filter.jf': 3,  # filter.h:27 __u8 jf, offset 3
    'sock_filter.k': 4,  # filter.h:28 __u32 k, 4-aligned, offset 4
    'BPF_MAXINSNS': 4096,  # bpf_common.h:54 #define BPF_MAXINSNS 4096 (inside #ifndef BPF_MAXINSNS)
    'PR_SET_DUMPABLE': 4,  # linux-6.8/include/uapi/linux/prctl.h:14
    'PR_SET_KEEPCAPS': 8,  # prctl.h:25
    'PR_SET_SECCOMP': 22,  # prctl.h:68
    'PR_CAPBSET_DROP': 24,  # prctl.h:72
    'PR_SET_SECUREBITS': 28,  # prctl.h:82
    'PR_SET_NO_NEW_PRIVS': 38,  # prctl.h:175
    'PR_CAP_AMBIENT': 47,  # prctl.h:195
    'PR_CAP_AMBIENT_RAISE': 2,  # prctl.h:197
    'PR_CAP_AMBIENT_CLEAR_ALL': 4,  # prctl.h:199
    'SUID_DUMP_DISABLE': 0,  # linux-6.8/include/linux/sched/coredump.h:7
    '_LINUX_CAPABILITY_VERSION_3': 0x20080522,  # linux-6.8/include/uapi/linux/capability.h:36
    'CAP_LAST_CAP': 40,  # capability.h:421 #define CAP_LAST_CAP CAP_CHECKPOINT_RESTORE; CAP_CHECKPOINT_RESTORE is 40 at capability.h:419
    '_LINUX_CAPABILITY_U32S_3': 2,  # capability.h:37
    'MS_RDONLY': 1,  # linux-6.8/include/uapi/linux/mount.h:13
    'MS_NOSUID': 2,  # mount.h:14
    'MS_NODEV': 4,  # mount.h:15
    'MS_NOEXEC': 8,  # mount.h:16
    'MS_REMOUNT': 32,  # mount.h:18
    'MS_BIND': 4096,  # mount.h:24
    'MS_REC': 16384,  # mount.h:26
    'MS_PRIVATE': 262144,  # mount.h:32 (1<<18) = 262144
    'CLONE_NEWNS': 0x00020000,  # linux-6.8/include/uapi/linux/sched.h:20
    'CLONE_NEWIPC': 0x08000000,  # sched.h:30
    'CLONE_NEWPID': 0x20000000,  # sched.h:32
    'F_DUPFD_CLOEXEC': 1030,  # linux-6.8/include/uapi/linux/fcntl.h:18 (F_LINUX_SPECIFIC_BASE + 6) = 1024 + 6
    'F_LINUX_SPECIFIC_BASE': 1024,  # linux-6.8/include/uapi/asm-generic/fcntl.h:192
    'AF_UNIX': 1,  # linux-6.8/include/linux/socket.h:190
    'AF_INET': 2,  # socket.h:192
    'AF_INET6': 10,  # socket.h:200
    'AF_VSOCK': 40,  # socket.h:231
    'SOCK_STREAM': 1,  # linux-6.8/include/linux/net.h:65 enum sock_type
    'SOCK_DGRAM': 2,  # net.h:66
    'SOCK_SEQPACKET': 5,  # net.h:69
    'SOCK_CLOEXEC': 524288,  # net.h:80 #define SOCK_CLOEXEC O_CLOEXEC; O_CLOEXEC = octal 02000000 (asm-generic/fcntl.h:63) = 0x80000
    'SOCK_NONBLOCK': 2048,  # net.h:82 #define SOCK_NONBLOCK O_NONBLOCK; O_NONBLOCK = octal 00004000 (asm-generic/fcntl.h:39) = 0x800
    'O_NONBLOCK': 2048,  # linux-6.8/include/uapi/asm-generic/fcntl.h:39 octal 00004000 = 0x800 = 2048
    'O_CLOEXEC': 524288,  # asm-generic/fcntl.h:63 octal 02000000 = 0x80000 = 524288
}
