# 自托管认证身份与独立成员身份

本站使用 Better Auth 在自己的 PostgreSQL 中保存认证用户、session、验证令牌和登录账户，并通过 Resend 投递邮件魔法链接；本站成员资料继续使用独立的 `marketplace_members.id`，由私有映射表连接认证用户。认证不启用密码，相同邮箱的 OAuth 身份禁止隐式合并，Google 只能在已登录成员显式发起且完成供应商验证后绑定，OAuth token 加密存储。TONE3000 连接不进入这套身份或权限模型。

成员和认证用户分离，让公开作品归属、handle 历史、注销占位与第三方登录方式生命周期互不耦合；公开创作者接口只从成员资料投影白名单字段。handle claim 只追加，当前 handle 修改需通过 90 天窗口和乐观并发检查，旧 handle 永不释放并永久跳转。

选择自托管认证而不是另一个托管身份事实源，是为了复用现有 PostgreSQL 事务边界与标准 `Request → Response` 部署 seam，同时避免平台所有权依赖 TONE3000 或新供应商。Better Auth 的魔法链接令牌使用哈希、单次消费和五分钟有效期；邮件和 Google 凭据仅由服务端环境提供。
