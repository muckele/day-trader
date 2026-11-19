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
    '__NR_exit': 93,  # linux-6.8/include/uapi/asm-generic/unistd.h:258 #define __NR_exit 93
    '__NR_exit_group': 94,  # linux-6.8/include/uapi/asm-generic/unistd.h:260 #define __NR_exit_group 94
    '__NR_bind': 200,  # linux-6.8/include/uapi/asm-generic/unistd.h:526 #define __NR_bind 200
    '__NR_listen': 201,  # linux-6.8/include/uapi/asm-generic/unistd.h:528 #define __NR_listen 201
    '__NR_clone': 220,  # linux-6.8/include/uapi/asm-generic/unistd.h:566 #define __NR_clone 220
    '__NR_execve': 221,  # linux-6.8/include/uapi/asm-generic/unistd.h:568 #define __NR_execve 221
    '__NR_execveat': 281,  # linux-6.8/include/uapi/asm-generic/unistd.h:679 #define __NR_execveat 281
    '__NR_clone3': 435,  # linux-6.8/include/uapi/asm-generic/unistd.h:781 under #ifdef __ARCH_WANT_SYS_CLONE3; #define __NR_clone3 435
    'EACCES': 13,  # linux-6.8/include/uapi/asm-generic/errno-base.h:17 #define EACCES 13
    'ENETUNREACH': 101,  # linux-6.8/include/uapi/asm-generic/errno.h:84 #define ENETUNREACH 101
    'EHOSTUNREACH': 113,  # linux-6.8/include/uapi/asm-generic/errno.h:96 #define EHOSTUNREACH 113
    'VMADDR_CID_HOST': 2,  # linux-6.8/include/uapi/linux/vm_sockets.h:127 #define VMADDR_CID_HOST 2
    '__SO_ACCEPTCON': 65536,  # linux-6.8/include/uapi/linux/net.h:56 (1 << 16) = 0x10000
    'O_ACCMODE': 3,  # linux-6.8/include/uapi/asm-generic/fcntl.h:19 octal 00000003
    'O_RDONLY': 0,  # linux-6.8/include/uapi/asm-generic/fcntl.h:20 octal 00000000
    'O_WRONLY': 1,  # linux-6.8/include/uapi/asm-generic/fcntl.h:21 octal 00000001
    'O_RDWR': 2,  # linux-6.8/include/uapi/asm-generic/fcntl.h:22 octal 00000002
    'O_CREAT': 64,  # linux-6.8/include/uapi/asm-generic/fcntl.h:24 octal 00000100 = 0x40; not overridden by arm64 fcntl.h
    'O_EXCL': 128,  # linux-6.8/include/uapi/asm-generic/fcntl.h:27 octal 00000200 = 0x80; not overridden by arm64 fcntl.h
    'O_NOFOLLOW': 32768,  # linux-6.8/arch/arm64/include/uapi/asm/fcntl.h:24 octal 0100000 = 0x8000 (arm64 override)
    'NAME_MAX': 255,  # linux-6.8/include/uapi/linux/limits.h:12 #define NAME_MAX 255
    'IFNAMSIZ': 16,  # linux-6.8/include/uapi/linux/if.h:33 #define IFNAMSIZ 16 under #if __UAPI_DEF_IF_IFNAMSIZ
    'RTF_UP': 1,  # linux-6.8/include/uapi/linux/route.h:51 #define RTF_UP 0x0001
    'RTF_GATEWAY': 2,  # linux-6.8/include/uapi/linux/route.h:52 #define RTF_GATEWAY 0x0002
    'RTF_REJECT': 512,  # linux-6.8/include/uapi/linux/route.h:61 #define RTF_REJECT 0x0200
    'RTF_NONEXTHOP': 2097152,  # linux-6.8/include/uapi/linux/ipv6_route.h:27 #define RTF_NONEXTHOP 0x00200000
    'RTF_LOCAL': 2147483648,  # linux-6.8/include/uapi/linux/ipv6_route.h:40 #define RTF_LOCAL 0x80000000
    'TCP_ESTABLISHED': 1,  # linux-6.8/include/net/tcp_states.h:13 enum { TCP_ESTABLISHED = 1,
    'SECCOMP_FILTER_FLAG_SPEC_ALLOW': 4,  # linux-6.8/include/uapi/linux/seccomp.h:23 #define SECCOMP_FILTER_FLAG_SPEC_ALLOW (1UL << 2) = 4
    'SECCOMP_FILTER_FLAG_NEW_LISTENER': 8,  # linux-6.8/include/uapi/linux/seccomp.h:24 #define SECCOMP_FILTER_FLAG_NEW_LISTENER (1UL << 3) = 8
    'SECCOMP_FILTER_FLAG_LOG': 2,  # linux-6.8/include/uapi/linux/seccomp.h:22 #define SECCOMP_FILTER_FLAG_LOG (1UL << 1) = 2
    'SECCOMP_FILTER_FLAG_TSYNC_ESRCH': 16,  # linux-6.8/include/uapi/linux/seccomp.h:25 #define SECCOMP_FILTER_FLAG_TSYNC_ESRCH (1UL << 4) = 16
    'CLONE_NEWUSER': 268435456,  # linux-6.8/include/uapi/linux/sched.h:31 #define CLONE_NEWUSER 0x10000000
    'CLONE_NEWNET': 1073741824,  # linux-6.8/include/uapi/linux/sched.h:33 #define CLONE_NEWNET 0x40000000
    'AF_PACKET': 17,  # linux-6.8/include/linux/socket.h:208 #define AF_PACKET 17
    'SOCK_RAW': 3,  # linux-6.8/include/linux/net.h:67 SOCK_RAW = 3, in enum sock_type under #ifndef ARCH_HAS_SOCKET_TYPES (net.h:48); arm64 does not define it (see record)
    'MNT_DETACH': 2,  # linux-6.8/include/linux/fs.h:1156 #define MNT_DETACH	0x00000002	/* Just detach from the tree */
    '__NR_recvmsg': 212,  # linux-6.8/include/uapi/asm-generic/unistd.h:550 #define __NR_recvmsg 212 (outside any conditional; arm64 uapi/asm/unistd.h only defines __ARCH_WANT_* and includes asm-generic/unistd.h)
    'MSG_CMSG_CLOEXEC': 1073741824,  # linux-6.8/include/linux/socket.h:332 #define MSG_CMSG_CLOEXEC 0x40000000 (no arm64 override; linux/socket.h is generic)
    'SCM_RIGHTS': 1,  # linux-6.8/include/linux/socket.h:177 #define SCM_RIGHTS	0x01 (no arm64 override)
    'SOL_SOCKET': 1,  # linux-6.8/include/uapi/asm-generic/socket.h:9 #define SOL_SOCKET	1 (arm64 has no uapi/asm/socket.h; generic via mandatory-y)
    'ENOTSOCK': 88,  # linux-6.8/include/uapi/asm-generic/errno.h:71 #define	ENOTSOCK	88 (arm64 has no uapi/asm/errno.h; generic via mandatory-y)
    'EBADF': 9,  # linux-6.8/include/uapi/asm-generic/errno-base.h:13 #define	EBADF		 9 (included by asm-generic/errno.h; no arm64 override)
    'ECONNREFUSED': 111,  # linux-6.8/include/uapi/asm-generic/errno.h:94 #define	ECONNREFUSED	111 (no arm64 override)
    'ENOENT': 2,  # linux-6.8/include/uapi/asm-generic/errno-base.h:6 #define	ENOENT		 2 (no arm64 override)
    'ENOEXEC': 8,  # linux-6.8/include/uapi/asm-generic/errno-base.h:12 #define	ENOEXEC		 8 (no arm64 override)
    'PTRACE_ATTACH': 16,  # linux-6.8/include/uapi/linux/ptrace.h:22 #define PTRACE_ATTACH		  16 (arm64 uapi/asm/ptrace.h does not define it)
    'PTRACE_SEIZE': 16902,  # linux-6.8/include/uapi/linux/ptrace.h:53 #define PTRACE_SEIZE		0x4206 (arm64 uapi/asm/ptrace.h does not define it)
    'SIGSYS': 31,  # linux-6.8/include/uapi/asm-generic/signal.h:46 #define SIGSYS		31 (arm64 uapi/asm/signal.h defines only SIGSTKSZ and includes asm-generic/signal.h; no override)
    'AUDIT_FILTER_EXIT': 4,  # linux-6.8/include/uapi/linux/audit.h:169 #define AUDIT_FILTER_EXIT 0x04 (= 4)
    'AUDIT_ALWAYS': 2,  # linux-6.8/include/uapi/linux/audit.h:182 #define AUDIT_ALWAYS 2
    'AUDIT_ARCH': 11,  # linux-6.8/include/uapi/linux/audit.h:260 #define AUDIT_ARCH 11
    'AUDIT_EQUAL': 1073741824,  # linux-6.8/include/uapi/linux/audit.h:322 #define AUDIT_EQUAL 0x40000000 (0x40000000 = 1073741824)
    'AUDIT_GET': 1000,  # linux-6.8/include/uapi/linux/audit.h:54 #define AUDIT_GET 1000
    'AUDIT_LIST_RULES': 1013,  # linux-6.8/include/uapi/linux/audit.h:67 #define AUDIT_LIST_RULES 1013
    'AUDIT_SYSCALL': 1300,  # linux-6.8/include/uapi/linux/audit.h:87 #define AUDIT_SYSCALL 1300
    'AUDIT_PATH': 1302,  # linux-6.8/include/uapi/linux/audit.h:89 #define AUDIT_PATH 1302
    'AUDIT_CONFIG_CHANGE': 1305,  # linux-6.8/include/uapi/linux/audit.h:92 #define AUDIT_CONFIG_CHANGE 1305
    'AUDIT_SOCKADDR': 1306,  # linux-6.8/include/uapi/linux/audit.h:93 #define AUDIT_SOCKADDR 1306
    'AUDIT_CWD': 1307,  # linux-6.8/include/uapi/linux/audit.h:94 #define AUDIT_CWD 1307
    'AUDIT_EXECVE': 1309,  # linux-6.8/include/uapi/linux/audit.h:95 #define AUDIT_EXECVE 1309
    'AUDIT_EOE': 1320,  # linux-6.8/include/uapi/linux/audit.h:105 #define AUDIT_EOE 1320
    'AUDIT_PROCTITLE': 1327,  # linux-6.8/include/uapi/linux/audit.h:112 #define AUDIT_PROCTITLE 1327
    'AUDIT_STATUS_ENABLED': 1,  # linux-6.8/include/uapi/linux/audit.h:342 #define AUDIT_STATUS_ENABLED 0x0001 (= 1)
    'AUDIT_STATUS_FAILURE': 2,  # linux-6.8/include/uapi/linux/audit.h:343 #define AUDIT_STATUS_FAILURE 0x0002 (= 2)
    'AUDIT_STATUS_PID': 4,  # linux-6.8/include/uapi/linux/audit.h:344 #define AUDIT_STATUS_PID 0x0004 (= 4)
    'AUDIT_STATUS_RATE_LIMIT': 8,  # linux-6.8/include/uapi/linux/audit.h:345 #define AUDIT_STATUS_RATE_LIMIT 0x0008 (= 8)
    'AUDIT_STATUS_BACKLOG_LIMIT': 16,  # linux-6.8/include/uapi/linux/audit.h:346 #define AUDIT_STATUS_BACKLOG_LIMIT 0x0010 (= 16)
    'AUDIT_BITMASK_SIZE': 64,  # linux-6.8/include/uapi/linux/audit.h:188 #define AUDIT_BITMASK_SIZE 64
    'AUDIT_MAX_FIELDS': 64,  # linux-6.8/include/uapi/linux/audit.h:186 #define AUDIT_MAX_FIELDS 64
    'RTMGRP_LINK': 1,  # linux-6.8/include/uapi/linux/rtnetlink.h:682 #define RTMGRP_LINK 1
    'RTMGRP_IPV4_IFADDR': 16,  # linux-6.8/include/uapi/linux/rtnetlink.h:687 #define RTMGRP_IPV4_IFADDR 0x10 (= 16)
    'RTMGRP_IPV4_ROUTE': 64,  # linux-6.8/include/uapi/linux/rtnetlink.h:689 #define RTMGRP_IPV4_ROUTE 0x40 (= 64)
    'RTMGRP_IPV6_IFADDR': 256,  # linux-6.8/include/uapi/linux/rtnetlink.h:692 #define RTMGRP_IPV6_IFADDR 0x100 (= 256)
    'RTMGRP_IPV6_ROUTE': 1024,  # linux-6.8/include/uapi/linux/rtnetlink.h:694 #define RTMGRP_IPV6_ROUTE 0x400 (= 1024)
    'RTM_NEWLINK': 16,  # linux-6.8/include/uapi/linux/rtnetlink.h:28 enum member `RTM_NEWLINK = 16,` (explicit; self-define `#define RTM_NEWLINK RTM_NEWLINK` at :29 does not change value)
    'RTM_NEWADDR': 20,  # linux-6.8/include/uapi/linux/rtnetlink.h:37 enum member `RTM_NEWADDR = 20,` (explicit; self-define `#define RTM_NEWADDR RTM_NEWADDR` at :38 does not change value)
    'RTM_NEWROUTE': 24,  # linux-6.8/include/uapi/linux/rtnetlink.h:44 enum member `RTM_NEWROUTE = 24,` (explicit; self-define `#define RTM_NEWROUTE RTM_NEWROUTE` at :45 does not change value)
    'NLM_F_MULTI': 2,  # linux-6.8/include/uapi/linux/netlink.h:63 #define NLM_F_MULTI 0x02 (= 2)
    'NLM_F_ACK': 4,  # linux-6.8/include/uapi/linux/netlink.h:64 #define NLM_F_ACK 0x04 (= 4)
    'NLM_F_DUMP_INTR': 16,  # linux-6.8/include/uapi/linux/netlink.h:66 #define NLM_F_DUMP_INTR 0x10 (= 16)
    'NLMSG_ERROR': 2,  # linux-6.8/include/uapi/linux/netlink.h:113 #define NLMSG_ERROR 0x2 (= 2)
    'NLMSG_DONE': 3,  # linux-6.8/include/uapi/linux/netlink.h:114 #define NLMSG_DONE 0x3 (= 3)
    'IN_MODIFY': 2,  # linux-6.8/include/uapi/linux/inotify.h:31 #define IN_MODIFY 0x00000002 (= 2)
    'IN_ATTRIB': 4,  # linux-6.8/include/uapi/linux/inotify.h:32 #define IN_ATTRIB 0x00000004 (= 4)
    'IN_CLOSE_WRITE': 8,  # linux-6.8/include/uapi/linux/inotify.h:33 #define IN_CLOSE_WRITE 0x00000008 (= 8)
    'IN_MOVED_FROM': 64,  # linux-6.8/include/uapi/linux/inotify.h:36 #define IN_MOVED_FROM 0x00000040 (= 64)
    'IN_MOVED_TO': 128,  # linux-6.8/include/uapi/linux/inotify.h:37 #define IN_MOVED_TO 0x00000080 (= 128)
    'IN_CREATE': 256,  # linux-6.8/include/uapi/linux/inotify.h:38 #define IN_CREATE 0x00000100 (= 256)
    'IN_DELETE': 512,  # linux-6.8/include/uapi/linux/inotify.h:39 #define IN_DELETE 0x00000200 (= 512)
    'IN_DELETE_SELF': 1024,  # linux-6.8/include/uapi/linux/inotify.h:40 #define IN_DELETE_SELF 0x00000400 (= 1024)
    'IN_MOVE_SELF': 2048,  # linux-6.8/include/uapi/linux/inotify.h:41 #define IN_MOVE_SELF 0x00000800 (= 2048)
    'IN_UNMOUNT': 8192,  # linux-6.8/include/uapi/linux/inotify.h:44 #define IN_UNMOUNT 0x00002000 (= 8192)
    'IN_Q_OVERFLOW': 16384,  # linux-6.8/include/uapi/linux/inotify.h:45 #define IN_Q_OVERFLOW 0x00004000 (= 16384)
    'IN_IGNORED': 32768,  # linux-6.8/include/uapi/linux/inotify.h:46 #define IN_IGNORED 0x00008000 (= 32768)
    'IN_DONT_FOLLOW': 33554432,  # linux-6.8/include/uapi/linux/inotify.h:54 #define IN_DONT_FOLLOW 0x02000000 (= 33554432)
    'IN_MASK_CREATE': 268435456,  # linux-6.8/include/uapi/linux/inotify.h:56 #define IN_MASK_CREATE 0x10000000 (= 268435456)
}
