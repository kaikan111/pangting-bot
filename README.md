# 旁听生 · 群聊机器人（NapCat / OneBot 11）

> 群里那个旁听生 —— 没叫到不插嘴，一开口就知道你上周说过什么。

一个跑在 QQ 群里的聊天机器人：有人设、会记人、能接梗、会发语音，带一个只绑本机的控制台。
单进程 Node，无数据库，所有状态都是 `data/` 下的 JSON 文件，删掉即重置。

## 它有什么

- **人格化对话** —— 人设写在一个 txt 里（`personas/`），说话风格、口头禅、情绪、拆条发消息都可配
- **认人** —— 拉群成员花名册，给每个群友建档案（脾气、雷区），长期记忆 + 上下文摘要，重启不丢
- **群准入** —— 默认 @ 才回；也可以开「接力窗口」（@ 一次能连说几句）或一视同仁
- **管理员禁言** —— 她可以禁言挑衅她的人，但有三道闸（挑衅词审核 / 同人冷却 / 自己人不禁）
- **梗库** —— 255 条梗，几十条常驻 + 按这轮的话检索命中，贴在提示词末尾强制显形
- **表情包** —— 自建仓库，按情绪挑图发；支持从控制台导入导出
- **语音** —— 默认用微软 Edge TTS（在线，14 把嗓子能点单）；也能切成本地 sherpa-onnx（不联网）
- **旁听与主动** —— 群里没人 @ 她也记着刚才聊了什么；隔久了会主动找人说话
- **控制台** —— `127.0.0.1:3010`，7 个页签：驾驶舱 / 对话 / 语音 / 人物 / 梗库 / 表情包 / 设置

## 需要什么

- Node.js **20+**
- 一个 QQ 小号，用 [NapCat](https://github.com/NapNeko/NapCatQQ) 或任意 OneBot 11 实现的 **WebSocket 服务端**登录
- 一个 OpenAI 兼容的模型 API（默认 DeepSeek）

## 三步跑起来

```bash
npm install
cp .env.example .env        # Windows 用 copy .env.example .env
# 编辑 .env：至少填 WS_URL / WS_TOKEN / API_KEY / OWNER_QQ
npm start
```

控制台另起一个进程：

```bash
npm run panel               # 打开 http://127.0.0.1:3010
```

想让它崩了自己起来，用 `guardian.ps1`（Windows 计划任务或开机自启里跑 `powershell -File guardian.ps1`）；它会同时看着 bot 和面板，并把 pid 写进 `.bot.pid` / `.panel.pid`。

## 配置

`.env.example` 里有 **103 个键**，每一项都带一行中文注释，分 13 组。只填这四项就能跑：

| 键 | 说明 |
|---|---|
| `WS_URL` | NapCat 里配的 OneBot 11 WebSocket 服务端，默认 `ws://127.0.0.1:3001` |
| `WS_TOKEN` | 同一个地方配的 token，两边要一致 |
| `API_KEY` | 模型 API key |
| `OWNER_QQ` | 你自己的 QQ 号（认主人、私聊、主动找人都靠它） |

常改的几个：

| 键 | 默认 | 说明 |
|---|---|---|
| `GROUP_NEED_AT` | true | 群里要不要 @ 才回 |
| `GROUP_FOLLOW_TURNS` / `GROUP_FOLLOW_MINUTES` | 3 / 5 | 接力窗口：@ 一次能连说几句、多久过期 |
| `GROUP_BAN_MINUTES` | 10 | 禁言默认时长 |
| `MEME_LIB` / `MEME_TOP` | true / 4 | 梗库开关、每轮检索几条 |
| `VOICE` / `VOICE_ENGINE` | true / edge | 语音开关、引擎（edge 在线 / local 本地） |
| `SYSTEM_PROMPT_FILE` | personas/00_示例人设.txt | 人设文件 |

改完 `.env` 要**重启 bot** 才生效；控制台「设置」页能改的那几项（接力窗口、禁言时长、记忆时长、默认声音、人设、梗库常驻、表情包）是热生效的。

## 人设怎么写

`personas/00_示例人设.txt` 是模板，直接改它，或者复制一份改成自己的，再把 `SYSTEM_PROMPT_FILE` 指过去。
写的时候一条经验：**别堆形容词，给台词样例**。「她很毒舌」模型会演成刻薄；给三句具体的损人话，它才学得像。

## 语音

- **默认（edge）**：不用装任何东西，联网调微软 Edge TTS，秒出。
- **本地（local）**：先下模型，再改 `.env`。

```bash
npm run models            # 三套全下，约 400MB
node fetch-models.mjs kokoro   # 只下 kokoro
```

| 模型 | 体积 | 特点 |
|---|---|---|
| kokoro | 126MB | 54 个音色（中文 8 把），最自然，CPU 上约 1/3 实时速度 |
| melo | 159MB | 中文女声，接近 1 倍实时 |
| ll | 113MB | 五个音色，最快，音色偏闷 |

然后在 `.env` 里设 `VOICE_ENGINE=local`、`VOICE_LOCAL_MODEL=kokoro`。
模型版权归上游（hexgrad/Kokoro-82M、myshell-ai/MeloTTS、k2-fsa），商用前请核对各自的 LICENSE。

## 目录

```
bot.mjs                 主程序（单文件）
panel.mjs / panel.html  控制台（独立进程，只绑 127.0.0.1）
panel-bridge.mjs        bot → 面板的状态文件桥
voice.mjs               语音入口（edge / local 两套嗓子）
voice-local.mjs         本地引擎：切句、停顿、归一化
voice-local-worker.mjs  本地合成的常驻 worker
unban.mjs               手动解禁小工具
guardian.ps1            保活脚本
fetch-models.mjs        下语音模型
personas/               人设
data/                   运行时数据（自动生成，可整个删掉重置）
stickers/               表情包仓库（自己往里丢图）
voice-models/           本地语音模型（fetch-models 下到这里）
```

## 数据文件

| 文件 | 内容 |
|---|---|
| `data/people.json` | 主人/熟人的称呼、备注、长期记忆、印象 |
| `data/groups.json` | 群花名册 + 每群最近 20 条旁听 |
| `data/voice.json` | 当前默认声音 |
| `data/panel-config.json` | 控制台改过的热配置 |
| `data/梗库.md` | 梗库（`### 梗名` 分条） |
| `data/subtext.txt` / `data/safety.txt` | 读人词表 / 安全墙词表 |

**这些都是私人数据，不要提交进 git** —— `.gitignore` 已经挡好了。

## 常见问题

- **一直 `connect ECONNREFUSED 3001`**：NapCat 没起来、QQ 掉线，或者 WS 服务端没开。先看 NapCat 那边。
- **`[FATAL] 请先在 .env 里填写 API_KEY`**：没加 `--env-file=.env`，或者 `.env` 没填。
- **控制台打不开**：面板是独立进程，要单独 `npm run panel`；它只绑 127.0.0.1，外网访问不到。
- **本地语音报缺模型**：`npm run models`；启动日志会打 `本地模型: Kokoro 多语 ✗ missing: model.int8.onnx` 这种提示。
- **群友第一次出现她不认识**：花名册每 `GROUP_ROSTER_MINUTES` 刷新一次，刚进群的人要等一轮。

## 免责声明

- 本项目依赖第三方 QQ 客户端框架（NapCat 等）与 OneBot 协议，**与腾讯官方无关**。
- 使用第三方客户端登录 QQ **存在账号风控、封号风险**，后果自负。
- 仅供学习交流；使用者对自己的使用行为负责，包括但不限于群规、他人隐私、所在地法律法规。
- 内置梗库、示例表情包、第三方模型与音色的版权归各自原作者。

## 许可证

MIT，见 [LICENSE](LICENSE)。
