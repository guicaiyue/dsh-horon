"""Tag: 记忆入库

写时门禁：节点入库（挂上本 Tag）或之后修改正文时，拒绝把会话流水账和超长巨块写进来，
并拒绝没有书腰的节点入库。只判形状，不判内容对错；存量用 `audit 记忆入库` 扫。

为什么需要它：没有这道门时，正文会一直长到一万多字节、书腰会漏填，
而这两件事都只能靠「下次主动去整理」发现 —— 整理永远追不上写入速度。
"""

import re

DESCRIPTION = (
    "on_mutation：入库（挂本 Tag）时若正文非空行合计超 8192 B、像整段对话/会话日志、"
    "或缺书腰（when_to_read），reject；之后改正文时同样查长度与流水账。\n"
    "audit：扫所有成员，列出超长、疑似流水账与缺书腰的存量节点。"
)

MAX_BYTES = 8192
MIN_SPEAKER_LINES = 8
MIN_TIMESTAMP_LINES = 8

_SPEAKER = (
    r"^\s*(?:[-*>]\s*)*(?:\*\*|__)?"
    r"(?:user|human|assistant|ai|system|用户|助手|我|你)"
    r"(?:\*\*|__)?\s*[:：]"
)
_TIMESTAMP = r"^\s*(?:>\s*)*(?:[-*]\s*)?\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s"
_HEADING = r"^\s*#{1,6}\s+"


def _bytes_without_blank(text):
    total = 0
    for line in text.splitlines():
        if line.strip():
            total += len(line.encode("utf-8"))
    return total


def _inspect(text):
    """返回拒绝/警告原因；形状合格返回 None。"""
    if not text:
        return None
    size = _bytes_without_blank(text)
    if size > MAX_BYTES:
        return (
            "正文非空行合计 " + str(size) + " B，超过 " + str(MAX_BYTES)
            + " B 上限。把历史流水拆成独立概念并互相指向，或压成指针句。"
        )
    speakers = 0
    stamps = 0
    has_heading = False
    for line in text.splitlines():
        if re.search(_SPEAKER, line, re.IGNORECASE):
            speakers += 1
        if re.search(_TIMESTAMP, line):
            stamps += 1
        if re.search(_HEADING, line):
            has_heading = True
    if speakers >= MIN_SPEAKER_LINES:
        return (
            "检测到 " + str(speakers) + " 行对话角色标记（用户：/助手：/user:/assistant:），"
            "这是整段对话转写，不是概念。把可复用的判断写成独立节点。"
        )
    if stamps >= MIN_TIMESTAMP_LINES and not has_heading:
        return "检测到 " + str(stamps) + " 行时间戳、且没有标题结构，像会话日志。"
    return None


def _reject_message(reason, intake):
    tail = (
        "正确做法：判断写成节点正文的「## 当前判断」，"
        "原始观察压成一条 `- [日期 时间] 情境 ｜ 我做了什么 ｜ 结果` "
        "追加到对应情境节点的「## 原始记录」，不新建整段记录。"
    )
    if intake:
        tail += "修正后重新 `add <节点> tag 记忆入库`；这段内容不要了就先 `delete <节点>`。"
    else:
        tail += "修正正文后再改。"
    return "「记忆入库」拒绝：" + reason + "\n" + tail


def _added_own_tag(ctx):
    if not ctx.changed:
        return False
    tags = ctx.changed.get("tags")
    if not tags:
        return False
    for item in tags.get("added", []):
        if (item.get("tag") == ctx.tag_name
                and item.get("concept_id") == ctx.this.concept_id):
            return True
    return False


def _missing_when_to_read(when_to_read):
    return not when_to_read or not when_to_read.strip()


def on_mutation(ctx):
    changed = ctx.changed or {}

    if "content" in changed:
        diff = changed["content"]
        reason = _inspect(diff.get("new") or "")
        if reason:
            ctx.reject(_reject_message(reason, False))
        return

    if _added_own_tag(ctx):
        reason = _inspect(ctx.this.content or "")
        if reason:
            ctx.reject(_reject_message(reason, True))
        if _missing_when_to_read(ctx.this.when_to_read):
            ctx.reject(
                "「记忆入库」拒绝：这个节点没有书腰（when_to_read 为空）。"
                "\n书腰是语义检索的唯一入口 —— 没有它，节点只能靠名字被翻到，"
                "等于入库即失联。\n先 `set " + str(ctx.this.concept_id)
                + " when_to_read \"<什么情况下该打开它>\"`，再重新 `add ... tag "
                + ctx.tag_name + "`。"
            )
        ctx.info(
            "已按「记忆入库」规范收录（正文 " + str(_bytes_without_blank(ctx.this.content or ""))
            + " B，书腰已填）。同一件事以后只 update --append，不再新建节点。"
        )


def audit_cluster(ctx):
    for c in ctx.cluster.concepts:
        if c.name == ctx.tag_name:
            continue
        reason = _inspect(c.content or "")
        if reason:
            ctx.warn("[记忆入库] " + c.name + " (id=" + str(c.concept_id) + "): " + reason)
        elif _missing_when_to_read(c.when_to_read):
            ctx.warn(
                "[记忆入库] " + c.name + " (id=" + str(c.concept_id)
                + "): 缺书腰（when_to_read 为空），语义检索到不了它。"
            )
