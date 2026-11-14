# Agent Note: ZIP 测试消费市场生产写入器而非副本

Status: implemented

## Problem

复制序列化器可能让生产 ZIP 写入器损坏后回归测试仍然通过。维护两份实现增加同步义务，却没有提供独立 oracle。

## Decision

[纯 ZIP helper](../../../../scripts/lib/market-zip.cjs) 是唯一写入器。[市场构建](../../../../scripts/market-build) 与 [ZIP 回归套件](../../../../scripts/market-zip.test.mjs) 共同消费它；测试保留独立头部解析器和提取断言。两份合成目录 fixture 将 helper 复制到构建脚本旁。

## Context & Efficiency Impact

删除一个重复写入器及同步规则。生产定义只改变归属而不改变格式；残余胶水是两处导入和 fixture 复制条目。Node CRC32、顺序、UTF-8 标志、文件模式、时间戳、stored 字节及已有格式限制不变。不新增归档依赖、ZIP64、压缩框架或提示词/工具 schema 开销。

## Alternatives considered

副本等值门禁仍保留两份生产者及额外义务。regex/eval 提取使测试依赖源码拼写。导出整个构建脚本会执行无关的模块级资产解析。纯兄弟 helper 避免这些成本；自包含 fixture 打包让位于多复制一个文件。

## Consequences

[干净检出回归](../../../../scripts/market-build-clean.test.mjs) 在真正完整的 fixture 构建后核对所有已提交下载的校验和，直接测试固定空归档及混合 UTF-8/二进制字节。故意引入 CRC 偏移故障必须使测试失败。遗漏兄弟文件会让 fixture 执行失败，而不是静默测试副本。独立的干净检出 ZIP 比较豁免保持不变，其意图需另行决策。没有已有 owning note 被取代。
