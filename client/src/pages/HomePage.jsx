export default function HomePage() {
  return (
    <div className="home">
      <h1>会场发言计时</h1>
      <p className="subtitle">单控制台 · 多屏联播 · 议程偏差推演 · 投屏场景编排 · 后台提示 · WebSocket 实时同步</p>
      <div className="home-cards">
        <a className="card card-console" href="/console">
          <span className="card-title">控制台</span>
          <span className="card-desc">
            维护有序议程（名称 / 计划开始 / 时长 / 固定标记），设定当前环节，
            开始 / 暂停 / 继续 / 提前结束 / 超时顺延；并可向一块、多块或全部在线投屏
            发送“请上场／加快／结束”及 30 字内自定义后台提示，实时查看未送达 / 已显示 / 已确认；
            还可编排最多 8 个<b>投屏场景</b>（倒计时 / 议程 / 提示 / 标记摘要模块及布局），
            按场景版本生成完整快照原子广播切换、逐屏查看确认状态；
            也能在当前环节记录“发言切换 / 设备故障”等现场标记并按本场会话导出 CSV（投屏不显示）。
            需要换人操作时，持有者可生成 60 秒一次性<b>交接码</b>，接收方输入后服务端原子转移控制权，
            计时、议程、巡检与投屏画面无缝连续。
          </span>
        </a>
        <a className="card card-display" href="/display">
          <span className="card-title">投屏页</span>
          <span className="card-desc">
            按控制台编排的当前场景一次性渲染：大屏倒计时、当前/下一环节及预计开始时间、
            内联后台提示与现场标记摘要（纵向 / 网格布局）；
            超时顺延、固定环节“时间不足”醒目提示；收到后台提示时全屏或模块内展示并可现场确认，
            断线重连自动恢复当前场景，刷新沿用同一块屏幕身份。
          </span>
        </a>
      </div>
      <p className="tip">投屏页建议浏览器按 F11 进入全屏；可在多块屏幕同时打开。</p>
    </div>
  );
}
