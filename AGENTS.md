## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Git 提交规范

基于 Conventional Commits。提交前用 `git status` 确认范围、`git add <files>` 只加入本次相关文件，并 `git diff --cached` 自检。

### 提交粒度

- 单次提交只做一类变更（feat / fix / docs …），不要混入无关的格式化、临时调试代码或未完成的实验性修改
- 每个提交都应可构建、可运行、可回滚
- 大型改动拆成多个可审查的小提交，每个提交保持逻辑完整

### 提交信息格式

```
<type>[<scope>]: <summary>

[body]

[footer]
```

| 字段 | 要求 |
| --- | --- |
| `type` | 必填，见下方类型表 |
| `scope` | 可选，用模块/目录名（如 `tournaments`、`patches`、`items`、`heroes`）；无明确范围可省略 |
| `summary` | 必填，中文、动词开头、长度 ≤ 50 字、不加句号 |
| `body` | 可选，补充动机、影响范围、迁移方式或实现细节 |
| `footer` | 可选，用于标注破坏性变更或关闭 issue |

```
feat(auth): 增加短信验证码登录功能

- 集成阿里云短信服务
- 新增验证码存储与校验逻辑
- 开放 /api/auth/sms 接口

关闭 #123
```

```
fix(api): 修复用户信息更新时未校验邮箱格式

用户传入非法邮箱会导致后续通知服务异常，现增加前端+后端双重校验。
```

### 提交类型

| type | 说明 |
| --- | --- |
| `init` | 项目初始化 |
| `feat` | 新功能 |
| `fix` | 错误修复 |
| `docs` | 文档变更 |
| `style` | 代码格式化（不影响代码逻辑，如空格、缩进、分号） |
| `refactor` | 代码重构（不新增功能或修复错误） |
| `perf` | 性能优化 |
| `test` | 测试相关（新增或修改测试用例） |
| `build` | 构建系统或外部依赖变更 |
| `ci` | CI 配置相关 |
| `chore` | 构建过程或辅助工具变动 |
| `revert` | 撤销之前的提交（需在 body 中注明被撤销的 commit id） |

### 破坏性变更

- 在 type 后加 `!`（如 `feat(api)!: 重构用户认证接口`），或在 footer 写 `BREAKING CHANGE: <描述>`
- 必须明确说明受影响范围与升级/迁移指引

### 提交流程

1. `git status` 确认当前改动范围
2. `git add <files>` 仅添加本次提交相关的文件
3. `pnpm build` 确认可构建（本仓库尚未配置 lint / `astro check`，不要声称跑过不存在的检查）
4. `git commit` 按上述格式撰写提交信息
5. 推送并按需发起 Pull Request

### 禁止

- 提交信息不要写「修改了 xxx 文件」这类无信息量内容
- 不要在 body 里复述 diff
- 不要用「优化」「调整」这类空洞动词，要写清动机

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
