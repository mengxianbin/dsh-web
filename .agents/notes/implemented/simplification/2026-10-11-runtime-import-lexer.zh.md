# Agent Note: 跟踪产物的 runtime import 门禁使用库词法器

Status: implemented

## Problem

手写词法状态必须跟随 JavaScript 字符串、正则、模板、注释及模块语法。扫描错误会误判依赖义务，即使包依赖策略本身很小。

## Decision

[runtime 依赖门禁](../../../../scripts/runtime-deps-check.mjs) 同步调用 `es-module-lexer/js`，投影解码后的字符串 `record.n` 值。`importSpecifiers` 保留为门禁及其[行为测试](../../../../scripts/runtime-deps-check.test.mjs) 消费的适配 seam。显式根开发依赖和锁文件入口钉住解析器；跟踪包/文件选择及所有依赖豁免保持不变。

## Context & Efficiency Impact

词法状态机及其语法维护义务被小型适配器和一个开发依赖替代。运行时包不新增依赖，提示词/工具 schema 不增加开销。库承担语法工作；仓库仍负责 manifest 策略、产物选择和适配测试。

## Alternatives considered

继续增加扫描状态：否决，正则/模板/转义场景会倍增同一义务。另写正则：否决，无法可靠区分语法与文字。使用完整解析器：校验更强，但模块 specifier 提取不需要这套机制。同步 JavaScript 入口避免异步初始化契约。

## Consequences

副作用、re-export、带注释/模板的动态 import、属性及转义 specifier 按语言语义处理。计算/插值 import 和 CommonJS require 调用仍不在门禁范围内。词法器能识别的畸形输入带产物路径抛错；这不是完整 JavaScript 语法校验器。解析保持串行，不改为工作树 glob。适配场景和跟踪产物门禁是保留的证明义务。不取代已有决策。
