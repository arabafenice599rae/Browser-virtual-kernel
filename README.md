# Browser-virtual-kernel
# browser-virtual-kernel

Advanced virtual kernel that runs entirely in the **browser**:

- Processes with states, priorities, and lifetime
- Unix-like syscalls (`sleep`, `log`, VFS, `exec`, `spawn`)
- PID-to-PID IPC and networking over **virtual ports**
- `shell` process that receives commands on port `9999`
- `echo-server` on port `8080` + `echo-client`

Everything is **pure frontend**, perfect for GitHub Pages:
GitHub serves the static files, the kernel runs in the browser.
