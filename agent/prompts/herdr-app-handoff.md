---
description: herdr-app-handoff
---
按 `hc --skill` 的手册，用 herdr-core（`hc`）启动一个新的 PI agent 完成以下任务；你只负责交接足够上下文，后续不需要关注。

最小流程：`hc run --bg --name <短名> --cwd <目录> -- pi` 起 → `hc send <短名> "<任务原文>"` → `hc read <短名> --lines 40` 确认它开始干活（文本停在输入框里就 `hc keys <短名> enter`）。任务长就写进文件，只给路径。

$@
