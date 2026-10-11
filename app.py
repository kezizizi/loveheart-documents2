"""爱心社「爱心足迹」查询系统 —— Streamlit 入口。

本地运行：
    streamlit run app.py

演示模式（不需要飞书密钥，用内置假数据预览界面）：
    AX_DEMO=1 streamlit run app.py        # macOS / Linux
    set AX_DEMO=1 && streamlit run app.py # Windows cmd
"""

from __future__ import annotations

import streamlit as st

from config import ORG_NAME
from ui import components, pages, state, theme

st.set_page_config(
    page_title=f"爱心足迹 · {ORG_NAME}",
    page_icon=theme.page_icon(),
    layout="centered",
    initial_sidebar_state="collapsed",
)


def main() -> None:
    try:
        pages.render_app()
    except Exception as exc:  # noqa: BLE001 - 兜底，避免整页白屏
        theme.inject_theme()
        detail = str(exc)
        hint = ""
        if "凭证" in detail or "secrets" in detail.lower():
            hint = (
                "飞书密钥没读到。<b>本地</b>：写进 <code>.streamlit/secrets.toml</code>；"
                "<b>Streamlit Cloud</b>：写进 <code>Settings → Secrets</code>，"
                "写完要<b>点保存</b>。<br/>"
                "内容必须是 <code>[feishu]</code> 段下的 <code>app_id</code> 与 "
                "<code>app_secret</code> —— 只粘两行 <code>key = \"value\"</code> "
                "而没有段头是不行的。<br/>"
                "想先看看界面，可以设 <code>AX_DEMO=1</code> 用演示数据启动。"
            )
        st.markdown(
            f"<div class='ax-note ax-note-error'><div><b>启动失败</b><br/>{hint}"
            # ⚠️ 异常文本可能含配置内容，必须转义；不转义还能把页面结构打坏
            f"<br/><span style='font-size:12px;opacity:.75'>技术信息："
            f"{components.esc(detail)}</span></div></div>",
            unsafe_allow_html=True,
        )


if __name__ == "__main__":
    main()


def _demo_flag() -> bool:  # pragma: no cover - 供文档与调试参考
    return state.demo_mode()
