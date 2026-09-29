import { useCallback, useEffect, useRef, useState } from 'react';
import { monoNow } from './time.js';
import {
  judgeSnapshot,
  judgeCue,
  judgeHandover,
  judgeScene,
  INITIAL_BASELINE,
  INITIAL_CUE_BASELINE,
  INITIAL_HANDOVER_BASELINE,
  INITIAL_SCENE_BASELINE,
} from './guard.js';

// 单一 WebSocket 连接管理：
//  - 自动重连（指数退避，上限 5s）；
//  - 快照版本守卫：低版本 / 旧纪元（服务端重启前）消息一律丢弃，画面不回滚；
//  - 提示（cue）守卫：旧 cueSeq / 旧纪元提示一律丢弃，新提示覆盖旧提示；
//  - 控制台心跳续租，断线自动重新申请控制权；
//  - 投屏每次连接/重连用持久屏幕 ID 注册，重连后补发未确认最新提示。
const HEARTBEAT_MS = 5000;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5000;

export function useSocket({ role, screenRef }) {
  const [snap, setSnap] = useState(null);
  const [screens, setScreens] = useState([]);          // 控制台：所有投屏及最新提示状态
  const [markers, setMarkers] = useState([]);          // 控制台：本场会话现场标记（投屏收不到更新）
  const [markerMeta, setMarkerMeta] = useState(null);  // { sessionId } 本场会话信息
  const [inspection, setInspection] = useState(null);  // 控制台：设备巡检门禁状态（投屏收不到更新）
  const [gateEvent, setGateEvent] = useState(null);    // 门禁放行/失效翻转事件（含原因），供横幅提示
  const [devices, setDevices] = useState(null);        // 控制台：共享设备占用配置与实时冲突（投屏收不到）
  const [cue, setCue] = useState(null);                // 投屏：当前上屏的提示
  const [sceneLib, setSceneLib] = useState(null);      // 控制台：场景库（编排 + 激活版本）
  const [scene, setScene] = useState(null);            // 投屏：当前激活场景的完整快照
  const [screenConflict, setScreenConflict] = useState(false); // 投屏：同一 ID 被新连接顶替
  const [connState, setConnState] = useState('connecting'); // connecting | open | reconnecting
  const [control, setControl] = useState({ granted: false });
  const [myId, setMyId] = useState(null);              // 本连接服务端分配的 clientId
  const [handover, setHandover] = useState(null);      // 控制台交接：{ state, ... } 等待/成功/过期/取消
  const [lastError, setLastError] = useState(null);
  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const wantControlRef = useRef(role === 'console'); // 控制台始终希望持有控制权
  const heldRef = useRef(false); // 本连接当前是否持有租约（仅持有期间续租，避免非持有者心跳刷错误）
  const myIdRef = useRef(null);
  const baselineRef = useRef({ ...INITIAL_BASELINE });
  const cueBaselineRef = useRef({ ...INITIAL_CUE_BASELINE });
  const handoverBaselineRef = useRef({ ...INITIAL_HANDOVER_BASELINE });
  const sceneBaselineRef = useRef({ ...INITIAL_SCENE_BASELINE });
  const reportedSceneRef = useRef(0); // 已上报“已替换”的场景激活版本（重连同版本不重复上报）
  const reportedCueRef = useRef(0); // 已上报“已显示”的 cueSeq（同一条补发不重复上报）
  const screenRefRef = useRef(screenRef);
  screenRefRef.current = screenRef;

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  const acquire = useCallback(() => {
    wantControlRef.current = true;
    send({ command: 'acquire' });
  }, [send]);

  const release = useCallback(() => {
    wantControlRef.current = false;
    send({ command: 'release' });
    setControl({ granted: false });
  }, [send]);

  // 控制台交接：持有者生成/取消一次性交接码；接收方核销；clearHandover 仅清本地终态横幅
  const createHandover = useCallback(() => {
    send({ command: 'handover_create' });
  }, [send]);

  const cancelHandover = useCallback(() => {
    send({ command: 'handover_cancel' });
  }, [send]);

  const redeemHandover = useCallback((code) => {
    send({ command: 'handover_redeem', code: String(code ?? '').trim() });
  }, [send]);

  const clearHandover = useCallback(() => setHandover(null), []);

  const clearError = useCallback(() => setLastError(null), []);

  // 投屏修改显示名：持久化后重发注册（服务端立即改名并广播）
  const renameScreen = useCallback((name) => {
    const sid = screenRefRef.current;
    if (!sid) return;
    send({ command: 'screen_rename', screenId: sid.id, name });
  }, [send]);

  // 投屏人工确认当前提示：本地立即收起覆盖层（确认随后随名单对账），
  // 迟到的旧提示不会重新弹出——守卫只认 cueSeq 更高/相等。
  const ackCue = useCallback((cueSeq) => {
    const sid = screenRefRef.current;
    if (!sid) return;
    send({ command: 'cue_ack', screenId: sid.id, cueSeq });
    setCue((cur) => (cur && cur.cueSeq === cueSeq ? null : cur));
  }, [send]);

  useEffect(() => {
    let disposed = false;
    let heartbeatTimer = null;

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        retryRef.current = 0;
        setConnState('open');
        // 投屏：每次连接都用持久屏幕 ID 注册；重连后服务端补发未确认最新提示
        if (role === 'display' && screenRefRef.current) {
          const sid = screenRefRef.current;
          ws.send(JSON.stringify({
            command: 'screen_register',
            screenId: sid.id,
            name: sid.name,
          }));
        }
        // 重连后旧租约已被服务端释放，若之前持有/需要控制权则重新申请；
        // 仅控制台续租，投屏不发心跳（避免无意义的 NOT_CONTROLLER 错误）。
        if (role === 'console') {
          if (wantControlRef.current) ws.send(JSON.stringify({ command: 'acquire' }));
          heartbeatTimer = setInterval(() => {
            // 仅在确实持有时续租：交接转出 / 被拒 / 释放后停止心跳，
            // 既避免旧持有者迟到心跳干扰，也不向界面刷 NOT_CONTROLLER 错误。
            if (heldRef.current && ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ command: 'heartbeat' }));
            }
          }, HEARTBEAT_MS);
        }
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (msg.type === 'hello') {
          myIdRef.current = msg.clientId;
          setMyId(msg.clientId);
          // 连接/重连首包显式建立纪元基线；服务端重启后 epoch 变化，重置版本号
          baselineRef.current = { currentEpoch: msg.epoch, currentVersion: 0 };
          cueBaselineRef.current = { currentEpoch: msg.epoch, cueSeq: 0 };
          handoverBaselineRef.current = { currentEpoch: msg.epoch, seq: 0 };
          sceneBaselineRef.current = { currentEpoch: msg.epoch, activeVersion: 0 };
          reportedCueRef.current = 0;
          reportedSceneRef.current = 0;
          // 新纪元：丢弃上一纪元残留的门禁横幅（权威状态随 inspection 首包重建）
          setGateEvent(null);
          return;
        }

        if (msg.type === 'snapshot') {
          // 版本守卫：过期/重复/旧纪元消息一律丢弃，画面不得回滚
          const verdict = judgeSnapshot(baselineRef.current, msg);
          if (!verdict.accept) return;
          baselineRef.current = { currentEpoch: verdict.epoch, currentVersion: verdict.version };
          setSnap({ ...msg, receivedAtMono: monoNow() });

          // 控制权归属对账（可能被其他控制台顶掉/超时释放）
          const mine = msg.holderId != null && msg.holderId === myIdRef.current;
          heldRef.current = mine;
          setControl((prev) => {
            if (prev.granted === mine && prev.holderId === msg.holderId) return prev;
            return mine
              ? { granted: true, holderId: msg.holderId }
              : { granted: false, holderId: msg.holderId, locked: msg.locked };
          });
          return;
        }

        if (msg.type === 'screens') {
          // 屏幕名单（含每屏最新提示与状态、场景确认版本）由服务端权威整体替换
          setScreens(Array.isArray(msg.screens) ? msg.screens : []);
          return;
        }

        if (msg.type === 'scenes' && role === 'console') {
          // 场景库（编排内容 + 当前激活版本）由服务端权威整体替换；旧纪元残留丢弃
          if (baselineRef.current.currentEpoch !== null && msg.epoch !== baselineRef.current.currentEpoch) {
            return;
          }
          setSceneLib({
            seq: msg.seq,
            activeId: msg.activeId,
            activeVersion: msg.activeVersion,
            activeSeq: msg.activeSeq,
            scenes: Array.isArray(msg.scenes) ? msg.scenes : [],
          });
          return;
        }

        if (msg.type === 'scene_switch' && role === 'display') {
          // 投屏场景切换：epoch + activeVersion 守卫。
          // 更大版本=新场景，一次性替换（内嵌 snapshot 同步替换计时画面）；
          // 相等版本=断线重连/注册 replay，幂等；更小版本=旧场景迟到，丢弃不回滚。
          const verdict = judgeScene(sceneBaselineRef.current, msg);
          if (!verdict.accept) return;
          const isNewVersion = msg.activeVersion !== sceneBaselineRef.current.activeVersion;
          sceneBaselineRef.current = { currentEpoch: verdict.epoch, activeVersion: verdict.activeVersion };
          if (msg.snapshot && msg.snapshot.epoch === msg.epoch) {
            // 内嵌权威快照与切换严格同版本，先替换计时基线，避免周期快照晚到造成闪烁/回滚
            const snapVerdict = judgeSnapshot(baselineRef.current, msg.snapshot);
            if (snapVerdict.accept) {
              baselineRef.current = { currentEpoch: snapVerdict.epoch, currentVersion: snapVerdict.version };
              setSnap({ ...msg.snapshot, receivedAtMono: monoNow() });
              // 控制权归属随内嵌快照一并对账（与常规快照分支同一口径）
              const mine = msg.snapshot.holderId != null && msg.snapshot.holderId === myIdRef.current;
              heldRef.current = mine;
            }
          }
          setScene({
            activeVersion: msg.activeVersion,
            scene: msg.scene,
            markers: Array.isArray(msg.markers) ? msg.markers : [],
            receivedAtMono: monoNow(),
          });
          // 新版本首次应用立即上报；重连同版本 replay（服务端已重置该屏确认态）也重新上报。
          // activeVersion=0 是服务启动后尚未切换过的初始 replay，无版本可确认（不上报）。
          const sid = screenRefRef.current;
          if (msg.activeVersion > 0
            && (verdict.fresh || isNewVersion || reportedSceneRef.current !== msg.activeVersion)
            && sid) {
            reportedSceneRef.current = msg.activeVersion;
            send({ command: 'scene_displayed', screenId: sid.id, activeVersion: msg.activeVersion });
          }
          return;
        }

        if (msg.type === 'scene_markers' && role === 'display') {
          // 启用“标记摘要”模块的场景随标记增删收到整体替换；
          // epoch + activeVersion 守卫：旧场景/旧纪元迟到更新丢弃，不覆盖新场景。
          const verdict = judgeScene(sceneBaselineRef.current, msg);
          if (!verdict.accept) return;
          // 同版本更新：只替换当前已应用场景的标记；更大版本理论上由 scene_switch 承载
          sceneBaselineRef.current = { currentEpoch: verdict.epoch, activeVersion: verdict.activeVersion };
          setScene((prev) => {
            if (!prev || prev.activeVersion !== msg.activeVersion) return prev;
            if (!prev.scene?.modules?.markers?.enabled) return prev; // 当前场景未启用标记模块
            return { ...prev, markers: Array.isArray(msg.markers) ? msg.markers : [] };
          });
          return;
        }

        if (msg.type === 'markers') {
          // 现场标记由服务端权威整体替换；旧纪元（重启前）残留消息丢弃，列表不回滚
          if (baselineRef.current.currentEpoch !== null && msg.epoch !== baselineRef.current.currentEpoch) {
            return;
          }
          setMarkerMeta({ sessionId: msg.sessionId });
          setMarkers(Array.isArray(msg.markers) ? msg.markers : []);
          return;
        }

        if (msg.type === 'inspection') {
          // 巡检清单/门禁状态由服务端权威整体替换；旧纪元残留消息丢弃
          if (baselineRef.current.currentEpoch !== null && msg.epoch !== baselineRef.current.currentEpoch) {
            return;
          }
          setInspection({
            seq: msg.seq,
            armedSeq: msg.armedSeq,
            gate: msg.gate,
            items: Array.isArray(msg.items) ? msg.items : [],
          });
          return;
        }

        if (msg.type === 'inspection_gate') {
          // 门禁翻转（放行↔失效）广播：失效时带原因，供控制台横幅即时提示
          if (baselineRef.current.currentEpoch !== null && msg.epoch !== baselineRef.current.currentEpoch) {
            return;
          }
          setGateEvent({
            atMono: monoNow(),
            armed: !!msg.armed,
            reason: msg.reason ?? null,
            reasonText: msg.reasonText ?? '',
            gate: msg.gate ?? null,
            seq: msg.seq,
          });
          return;
        }

        if (msg.type === 'devices' && role === 'console') {
          // 共享设备占用（库 + 各环节预计起止占用 + 周转冲突）由服务端权威整体替换；
          // 冲突随议程/当前环节/计时逐帧重算，旧纪元残留丢弃。投屏连接永不收到该消息。
          if (baselineRef.current.currentEpoch !== null && msg.epoch !== baselineRef.current.currentEpoch) {
            return;
          }
          setDevices({
            seq: msg.seq,
            devices: Array.isArray(msg.devices) ? msg.devices : [],
            conflicts: Array.isArray(msg.conflicts) ? msg.conflicts : [],
          });
          return;
        }

        if (msg.type === 'handover' && role === 'console') {
          // 交接事件守卫：旧纪元/更旧 seq 丢弃；同 seq 的 pending 为带码补发（幂等补 code）
          const verdict = judgeHandover(handoverBaselineRef.current, msg);
          if (!verdict.accept) return;
          handoverBaselineRef.current = { currentEpoch: verdict.epoch, seq: verdict.seq };
          if (msg.state === 'pending') {
            setHandover((prev) => {
              // 同 seq 补发：仅在补发带来 code（生成者单播）时合并，其余字段不回退
              if (!verdict.fresh && prev && prev.state === 'pending' && prev.seq === msg.seq) {
                return { ...prev, code: prev.code ?? msg.code ?? null, receivedAtMono: monoNow() };
              }
              const { code, holderId, createdAtMono, expiresAtMono, ttlMs } = msg;
              return {
                state: 'pending',
                seq: msg.seq,
                code: code ?? null,
                holderId: holderId ?? null,
                createdAtMono: createdAtMono ?? null,
                expiresAtMono: expiresAtMono ?? null,
                ttlMs: ttlMs ?? null,
                serverTimeMono: msg.serverTimeMono ?? null,
                receivedAtMono: monoNow(),
              };
            });
          } else if (msg.state === 'idle') {
            setHandover(null);
          } else {
            // success | expired | cancelled：双方实时显示结果（由面板定时收起）
            setHandover({
              state: msg.state,
              seq: msg.seq,
              reason: msg.reason ?? null,
              holderId: msg.holderId ?? null,
              newHolderId: msg.newHolderId ?? null,
              atMono: monoNow(),
            });
          }
          return;
        }

        if (msg.type === 'cue' && role === 'display') {
          // 提示守卫：旧纪元 / 更小 cueSeq 的迟到消息一律丢弃；
          // cueSeq 相等为重连同一条补发（幂等），更大为新提示（覆盖）。
          const verdict = judgeCue(cueBaselineRef.current, msg);
          if (!verdict.accept) return;
          cueBaselineRef.current = { currentEpoch: verdict.epoch, cueSeq: verdict.cueSeq };
          const sid = screenRefRef.current;
          const nextCue = { cueSeq: msg.cueSeq, cueType: msg.cueType, text: msg.text };
          setCue(nextCue);
          setScreenConflict(false);
          // 新提示（或重启纪元后的首条）通知服务端“已上屏”；同一条补发不重复上报
          if (verdict.fresh || reportedCueRef.current !== msg.cueSeq) {
            reportedCueRef.current = msg.cueSeq;
            send({ command: 'cue_displayed', screenId: sid?.id, cueSeq: msg.cueSeq });
          }
          return;
        }

        if (msg.type === 'screen_hello' && role === 'display') {
          // 注册/改名确认：服务端规范化后的显示名回填本地身份
          if (msg.screen && screenRefRef.current?.id === msg.screen.id) {
            screenRefRef.current.name = msg.screen.name;
            setScreens((prev) => (prev.length ? prev : [msg.screen]));
          }
          return;
        }

        if (msg.type === 'screen_conflict' && role === 'display') {
          // 同一持久屏幕 ID 被更新的连接注册（通常是本屏页面被顶替）：
          // 本连接不再代表该屏，提示用户且不再上屏/确认，避免双屏互相打架。
          setScreenConflict(true);
          return;
        }

        if (msg.type === 'control') {
          // 控制权消息为单播；targetId 存在时仅当事连接处理
          if (msg.targetId && msg.targetId !== myIdRef.current) return;
          if (msg.granted) {
            heldRef.current = true;
            setControl({ granted: true, holderId: myIdRef.current });
          } else {
            heldRef.current = false;
            // 被拒绝 / 释放 / 断线 / 超时 / 交接转出，本端失去控制权
            setControl({
              granted: false,
              reason: msg.reason,
              holderId: msg.holderId ?? null,
              // 交接转出后锁仍被新持有者占用；locked/holderId 以下一帧权威快照对账为准
              locked: msg.reason === 'locked' || msg.reason === 'handover',
            });
          }
          return;
        }

        if (msg.type === 'error') {
          // 服务端指令错误（如 BAD_AGENDA / NOT_CONTROLLER），供控制台提示
          setLastError({ code: msg.code, message: msg.message || msg.code });
        }
      });

      ws.addEventListener('close', () => {
        clearInterval(heartbeatTimer);
        heldRef.current = false;
        if (disposed) return;
        setConnState('reconnecting');
        setControl((prev) => (prev.granted ? { ...prev, granted: false, reason: 'reconnect' } : prev));
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retryRef.current);
        retryRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => {
        ws.close();
      });
    };

    connect();

    return () => {
      disposed = true;
      clearInterval(heartbeatTimer);
      clearTimeout(reconnectTimerRef.current);
      const ws = wsRef.current;
      if (ws) {
        // 正常卸载：通知服务端释放租约（投屏无需额外注销，close 即标记离线）
        if (role === 'console' && wantControlRef.current && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ command: 'release' }));
        }
        ws.close();
      }
    };
  }, [role, send]);

  return {
    snap,
    screens,
    markers,
    markerMeta,
    inspection,
    gateEvent,
    devices,
    cue,
    sceneLib,
    scene,
    screenConflict,
    connState,
    control,
    myId,
    handover,
    lastError,
    send,
    acquire,
    release,
    renameScreen,
    ackCue,
    clearError,
    createHandover,
    cancelHandover,
    redeemHandover,
    clearHandover,
  };
}
