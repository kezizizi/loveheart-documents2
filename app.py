"""爱心社「爱心足迹」查询系统 —— Streamlit 入口。

界面本体是 ``static/web/`` 里的新版前端，由 :mod:`ui.embed` 以**自定义组件**的方式
挂到 Streamlit 上（前端因此拿到真实 URL，相对路径资源原样可用）。本文件只做两件事：
调用它，以及把异常兜住——绝不给用户一片白屏。

本地运行：
    streamlit run app.py

演示模式（不需要飞书密钥，用 tests/fixtures 里录制的真实响应形状）：
    AX_DEMO=1 streamlit run app.py        # macOS / Linux
    set AX_DEMO=1 && streamlit run app.py # Windows cmd

带参进入（便于分享与截图）：``http://localhost:8501/?name=张三&sid=2300017473``
"""

from __future__ import annotations

import html

import streamlit as st

from ui import embed


def main() -> None:
    try:
        embed.render()
    except Exception as exc:  # noqa: BLE001 - 页面级兜底，避免整页白屏
        _render_failure(exc)


def _render_failure(exc: Exception) -> None:
    """最外层兜底。异常文本可能带配置内容，**必须转义**。"""
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
        "<div style='max-width:820px;margin:64px auto;padding:20px 24px;"
        "border:1px solid #cdc9bf;border-left:4px solid #840923;background:#fff'>"
        "<b>启动失败</b><br/>" + hint
        + "<br/><span style='font-size:12px;color:#6a7078;word-break:break-all'>技术信息："
        + html.escape(detail) + "</span></div>",
        unsafe_allow_html=True,
    )


if __name__ == "__main__":
    main()
