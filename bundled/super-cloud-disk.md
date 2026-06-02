# 项目知识库 (KNOWLEDGE-BASE)

> 由 opencode-plugin-memory-capsule 自动加载与向量化。
> 格式：在文件里编辑 + `git commit` 即可让团队共享认知胶囊。

---

* **Cognitive Capsule: 超级云盘项目概况**

- **Version**: 2.0
- **Scenario**: 超级云盘 super-cloud-disk 是一个多云盘聚合管理前端，把 Alist 当作后端的云盘聚合引擎。系统由两部分组成：React 19 + Vite 8 + TypeScript + Tailwind v4 + Zustand 写的前端，和 Go + Gin + GORM + 92 个 storage driver 写的 Alist 后端。前端通过 Alist 的 REST API 代理所有 storage 操作，包括挂载、启用、禁用、删除网盘、文件浏览、上传、分享、离线下载。Alist 的密码必须用 SHA-256 哈希后传给 /api/auth/login/hash 端点。WebSocket 用于实时广播任务进度。Dashboard 端点聚合各 storage 的容量、最近文件、磁盘用量。
- **Pattern**: axios 响应拦截器不解包 envelope, await authApi.login 拿到的 resp 是 AxiosResponse 包装, 拿不到 token. AuthGuard 跳 /login. /api/admin/storage/list 返回 content total 分页, 不能当数组用. alist 密码哈希必须用 password-salt 短横线分隔, 直接拼接报错. enable/disable/delete 用 query string id 不是 body.
- **Invariant**: 1. Alist 密码哈希必须用 ${password}-${salt} 短横线分隔, 不是直接拼接。2. enable/disable/delete 用 ?id=N query string, 不是 body。3. list 端点返回 { content, total } 分页, 取 .content。4. Vite 代理 /api /d /p 到 5244。5. Admin 路由需要 admin 用户登录, 启动用 ALIST_ADMIN_PASSWORD。6. Alist 二次开发文件 super_disk_dashboard.go + super_disk_ws.go + wshub/hub.go + wshub/tasks.go, 升级 Alist 时这些文件会冲突。7. Dashboard 缓存 30s TTL, storage mutation 必须 InvalidateDashboardCache。8. WebSocket 必须用 gorilla/websocket, 业务端通过 client.Send(msg)。9. 登录密码哈希 SHA-256(password-https://github.com/alist-org/alist) 在浏览器侧 Web Crypto。10. admin/admin 测试, 真实环境改密码。11. 任务轮询 tache.Manager, 用 fs.UploadTaskManager。12. go-cache.WithEx 泛型 API, 必须 cache.WithEx[SuperDiskDashboardResp]。13. Local driver addition 必须是 JSON 字符串。14. share expire_at ISO8601 不是 expires Unix。15. share delete 用 share_id 字符串。16. share list 返回 content 数组。17. dashboard 缓存 key 是 dashboard 字符串。18. 拦截器用 payload.data as unknown as AxiosResponse 解包。19. 拖拽上传用 CustomEvent superdisk:dropfiles。20. AuthGuard me() 用 withAuthCheck 包装。
- **File Extensions**: 
- **Dependencies**: 
- **Keywords**: 
