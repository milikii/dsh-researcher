#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""shop_search_fallback.py — shop-search 的账本兜底层（L2）

被 shop-search.sh 的 gate() / post() 两段内嵌 python 共用（sys.path 指向 /root/.dsh/tools）。

职责：实时通道被阻断（冷却 / needs_human / soft_block / 配额 / 频控 / 变体拒绝 / 空结果）时，
把同关键词的账本历史 offers 挂到响应上，让调用方「拿到旧数据 + 明确的降级路线」，
而不是拿到一个空列表然后 sleep 重试或换词硬试（2026-09-03 评估 §2.5：7 次 sleep 重试、2 小时零产出）。

铁律：
  · 账本历史一律 C 级（nas-core §3：缓存价/时间未知 → C），每条带原 retrieved_at，绝不与 A 级实时价混列
  · 只读账本，不写；被挂了兜底的响应由包装器判 cache_source=ledger 后跳过 ledger 回写（防自我复制）
  · calls.log 记实时通道的真实产出数，不记兜底条数
"""
import json
import os
import subprocess

LEDGER_BIN = "/usr/local/bin/ledger"
NEXT_HINT = ("实时通道被阻断。products[] 为账本历史（C 级，各条 retrieved_at 为原检索时间，不是实时价）。"
             "需要新数据：① shop-search.sh offer <offerId|url>（详情页不触发风控，安全通道）"
             "② shop-search.sh cloud[:taobao|xhs] <kw>（C 级缓存价）"
             "③ 到 cooldown_until / quota_reset_at 后重跑同一命令——不要换关键词变体、不要 sleep 循环")


def ledger_history(state, kw, limit=20):
    """同关键词历史 offers（平台按族匹配：1688 与 1688:desktop 同族）。任何异常 → []，绝不阻塞主流程。"""
    if os.environ.get("NAS_LEDGER", "1") == "0" or not os.path.exists(LEDGER_BIN) or not kw:
        return []
    since = os.environ.get("SHOP_LEDGER_SINCE", "30d")
    try:
        r = subprocess.run([LEDGER_BIN, "search", kw, "--json", "--limit", "80", "--since", since],
                           capture_output=True, text=True, timeout=6)
        rows = json.loads(r.stdout or "[]")
    except Exception:
        return []
    if not isinstance(rows, list):
        return []
    fam = (state or "").split(":")[0]
    out = []
    for row in rows:
        if (row.get("platform") or "").split(":")[0] != fam:
            continue
        out.append({"title": row.get("title"), "price": row.get("price_raw"), "moq": row.get("moq"),
                    "sales": row.get("sales"), "repeat_rate": row.get("repeat_rate"),
                    "shop_age": row.get("shop_age"), "shop": row.get("shop"), "region": row.get("region"),
                    "url": row.get("url"), "offer_id": row.get("offer_id"),
                    "retrieved_at": row.get("retrieved_at"), "evidence": "C", "source": "ledger"})
        if len(out) >= limit:
            break
    return out


def attach_fallback(o, state, kw):
    """就地给被阻断的响应挂兜底。有历史 → products / evidence=C / from_cache / cache_source / cached_at；
    无论有无历史都给 fallback.next 降级路线。返回 o 便于链式使用。"""
    hist = ledger_history(state, kw)
    o["fallback"] = {"ledger_hits": len(hist), "next": NEXT_HINT}
    if hist:
        o["products"] = hist
        o["from_cache"] = True
        o["cache_source"] = "ledger"
        o["evidence"] = "C"
        o["cached_at"] = max((h.get("retrieved_at") or "") for h in hist)
    return o


if __name__ == "__main__":  # 手工自检：python3 shop_search_fallback.py 1688:desktop '多肽紧致精华'
    import sys
    st, k = (sys.argv[1], sys.argv[2]) if len(sys.argv) > 2 else ("1688:desktop", "充电器")
    print(json.dumps(attach_fallback({"platform": st, "keyword": k, "products": []}, st, k),
                     ensure_ascii=False, indent=1))
