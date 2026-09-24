## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Git 提交规范

基于 Conventional Commits。提交前用 `git status` 确认范围、`git add <files>` 只加入本次相关文件，并 `git diff --cached` 自检。

### 分支约定

- **日常开发与修 bug 都在 `develop` 分支进行**，`main` 只保留可发布的状态——改动先提交到 `develop`，需要发布时再合并上去
- 开会话时先 `git branch --show-current` 确认在 `develop` 上，别在 `main` 上直接改
- 没有明确要求就不要推送远程（`git push`），更不要发布（`wrangler deploy`、站点定时重建）；本地提交是默认动作，推送与发布都要单独确认

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

## Release 发布规范

GitHub Release 的说明是给读者看的**变更清单**，不是开发记录。分类列条目，只回答「变了什么、对使用者有什么影响」。

**标题只写版本号**（`v0.4.4`），不要带站点名或一句话概括——那些信息在说明里说，标题重复一遍只是噪音。

固定用这四个小标题，没有内容的分类直接不写：

- `## 新增` —— 新功能、新页面、新接口
- `## 优化` —— 行为或性能变好，但对外接口没变
- `## 修复` —— 修掉的 bug
- `## 其他变更` —— 依赖、CI、文档、权限这类

写法：

- 一条一事，用 `-` 列表项，不要写成段落
- 每条先说「哪里变了」，需要时补一句「为什么」，控制在两三行内
- 末尾附一行 `**完整变更**：https://github.com/jackbi/dota2-yizhan/compare/<上一版>...<本版>`

不要写进发布说明的：

- 实现思路与代码结构（调了哪个函数、用了什么机制）
- 排查与验证过程（实测了什么、量到多少数字）
- 内部取舍、设计讨论，以及任何「思考过程」性质的段落

这些属于提交 body、代码注释或 `docs/`，发布说明里只要结论。

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
