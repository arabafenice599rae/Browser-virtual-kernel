

# Browser-virtual-kernel

**A tiny virtual operating system that runs entirely in your browser.**  
It simulates a kernel with processes, IPC, ports, a virtual file system and an interactive shell, all written in JavaScript and rendered with a simple HTML UI.

👉 Live demo (GitHub Pages):  
https://arabafenice599rae.github.io/Browser-virtual-kernel/

---

## ✨ Features

- **Kernel core**
  - Process table with PID, name, priority, state, exit code, age
  - States: `READY`, `RUNNING`, `BLOCKED`, `TERMINATED`
  - Cooperative scheduler (`tick()` advances all processes)
  - Simple logging system with real-time “kernel log” view

- **Syscalls (Unix-like)**
  - Time & control: `sleep`, `exit`, `getPid`, `log`
  - IPC (process-to-process): `send`, `recv`
  - Ports / networking: `listen`, `sendToPort`, `recvFromPort`, `listPorts`
  - Process management: `spawn`, `kill`, `ps`
  - Virtual file system: `listFiles`, `readFile`, `writeFile`, `unlink`

- **Virtual networking**
  - Logical ports (e.g. `8080`, `9999`) with:
    - `ownerPid`
    - message queue length
  - Built-in echo server on port `8080`

- **Virtual File System (VFS)**
  - Fully in memory + persisted to `localStorage`
  - Example file: `/etc/motd`
  - Files survive page reloads
  - Exposed through shell commands and the UI

- **Interactive shell (PID 1)**
  - Listens on port `9999`
  - Accepts multiple commands separated by `;`
  - Each command spawns its own process (like a real OS shell)
  - Results are visible in the shell panel and kernel log

- **UI Dashboard**
  - Shell console with history and shortcuts
  - Process table
  - Ports table
  - VFS browser
  - Live kernel log
  - Dark / light theme toggle

