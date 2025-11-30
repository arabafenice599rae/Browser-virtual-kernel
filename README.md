# browser-virtual-kernel

Advanced virtual kernel that runs entirely in the **browser**:

- Processes with states, priorities, and lifetime
- Unix-like syscalls (`sleep`, `log`, VFS, `exec`, `spawn`, `kill`)
- Per-process virtual heap
- PID-to-PID IPC and networking over **virtual ports**
- Shell process that receives commands on port `9999`
- `echo-server` on port `8080` + `echo-client`
- Virtual file system (VFS) persisted in `localStorage`
- System programs:
  - `ps` – process table
  - `ls` – list VFS
  - `netstat` – open ports
  - `cat` – print file
  - `kill` – terminate process
  - `help` – list commands
