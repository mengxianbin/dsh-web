# Agent Note: 客户端 store 通过受支持宿主平台解析

Status: implemented

## Problem

双 cohort shim 捕获 store 模块解析错误，再尝试间接 legacy runtime face。低于支持下限的宿主承诺与家族支持边界冲突，并在每个消费 store 的 bundle 中保留死兼容机制。

## Decision

[共享客户端预设](../../../../shared/tsdown.client.ts) 将 store 视为普通[平台种子模块](../../../../shared/web-platform.ts)：由宿主解析的直接 external。虚拟模块、生成的回退函数体及 resolve/load 特例均不存在。[宿主下限 owner](../architecture/2026-09-01-dsh-host-floor-tracks-cohort.md) 和[当前 cohort owner](../architecture/2026-09-29-sdk-cohort-0.2.0-rc.2.md) 要求宿主提供该模块。

## Context & Efficiency Impact

删除一个虚拟模块、两阶段解析分支、catch/fallback 和 legacy-engine 兼容义务。平台 external、宿主拥有的身份、纯度检查、CSS 行为及 closure-factory loader 保持不变。不新增兼容替代层或提示词/工具 schema 开销。卫星预设与独立 vendored try-on shell 不改动。

## Alternatives considered

保留或探测旧宿主能力：否决，不支持低于声明下限的安装。打包私有 store：否决，会复制宿主所有权与身份。再次抬高下限：不需要，现有下限已经提供模块。直接宿主 external 就是既有受支持契约。

## Consequences

[已提交 bundle 契约](../../../../scripts/client-bundle-contract.test.mjs) 验证实际重建的客户端产物，拒绝 shim/legacy 标记并要求直接平台调用；仅源码指纹不覆盖此预设。重建 bundle 另在受支持宿主上实测：一次性 `DSH_HOME` 启动的隔离探针宿主加载了本检出客户端 bundle，依赖 store 的会话归档面板和使用统计卡片渲染正常且无模块解析错误；有意不保留低于下限的可导入性。这部分取代[原混合 owner](../bug-fix/2026-08-28-client-store-dual-cohort-engine-shim.md) 的 engine 绕行；其独立 agent-preset 声明/injection 理由仍有效并双向链接。
