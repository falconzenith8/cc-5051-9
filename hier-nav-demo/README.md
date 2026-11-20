# hier-nav-demo

连续世界探索的**分层导航**演示：粗层区域连通确定候选门户，精细块按需真实加载后
逐段求路与运动推进；精细层发现通道不满足角色尺寸时回溯修正。

## 快速开始（图形入口）

```bash
node src/server.js
# 浏览器打开 http://localhost:8080
```

左键设置起点、右键设置远程目标，点击 **开始远程求路**，再用 **单步 Tick / 自动推进**
观察分块加载、双层路径与近路阻断后的改道。

命令行仅用于 headless 辅助验证：`node src/cli.js demo`。

完整图形入口、界面说明、API 与架构见 [docs/USAGE.md](docs/USAGE.md)。

## 测试

```bash
npm test
```
