# 统一发现按类型分页，公开页面以不可变 id 为 canonical 身份

音色广场使用一个分栏入口发现预设、预设合集和创作者，但三个类型分别执行查询并维护自己的稳定游标。预设保留完整 Rig 派生筛选；合集只搜索 Public 合集的标题、介绍、受控标签和作者；创作者只搜索公开 handle 与显示名。合集搜索投影不读取条目，因此 Unlisted、Withdrawn 或 Hidden 来源的正文不会经合集结果泄漏。

公开预设、合集和创作者页面都以不可变内部 id 生成 canonical URL、标题与描述元数据。作品标题和合集标题不进入身份 URL；handle URL 作为兼容入口永久解析历史 claim，客户端随后转到 `/creators/id/:memberId`。Public 页面输出 `index,follow`，Unlisted 页面保留直接链接但输出 `noindex,nofollow`。

该选择让三类内容的排序和游标策略可以独立演进，也让标题或 handle 修改不会破坏外部链接。代价是创作者同时存在 handle 兼容入口和 id canonical 入口，API 与部署适配器必须保持两者一致。
