"""视图层：新版前端（``static/web``）的 Streamlit 宿主。

* :mod:`ui.embed` —— 组件声明、缓存装配与编排（会 import streamlit）。
* :mod:`ui.payload` —— 后端模型 → 前端契约的**纯函数**翻译（不 import streamlit），
  因此可以直接单测。

本文件刻意不 import 任何子模块：这样 ``from ui import payload`` 不会顺带把
Streamlit 的组件机制拉起来。
"""
