'use client';

import { useState } from 'react';
import { LifecyclePhaseTip, type LifecycleTipConfig } from './LifecyclePhaseTip';

interface BootcampGuideOverlayProps {
  catName?: string;
  phase: string;
  hasMessages?: boolean;
}

const PHASE_TIPS: Record<string, (catName: string) => string> = {
  'phase-1-intro': (cat) => `在下方输入框输入 @${cat} 你好  开始训练营`,
  'phase-2-env-check': (cat) => `${cat} 正在检查你的开发环境...`,
  'phase-3-config-help': (cat) => `跟着 ${cat} 的指引完成配置`,
};

const LIFECYCLE_TIPS: Record<string, LifecycleTipConfig> = {
  'phase-5-kickoff': { icon: '\u{1F680}', text: '告诉猫猫你想做什么项目，TA 会帮你分析和拆解需求', variant: 'blue' },
  'phase-6-design': { icon: '\u{1F3A8}', text: '猫猫会给出设计方案，选择你喜欢的然后继续', variant: 'purple' },
  'phase-7-dev': { icon: '\u{1F4BB}', text: '猫猫正在开发，遇到关键决策会问你', variant: 'amber' },
  'phase-8-collab': { icon: '\u{1F50D}', text: '多猫协作中，队友正在 review 代码', variant: 'blue' },
  'phase-9-complete': { icon: '\u2705', text: 'Review 通过，准备合入主分支', variant: 'green' },
  'phase-10-retro': { icon: '\u{1F4DD}', text: '和猫猫一起回顾这个项目，看看学到了什么', variant: 'amber' },
  'phase-11-farewell': { icon: '\u{1F393}', text: '恭喜完成训练营！你已经掌握了多猫协作的基本流程', variant: 'green' },
};

export function BootcampGuideOverlay({ catName, phase, hasMessages }: BootcampGuideOverlayProps) {
  // Hook 必须在任何提前 return 之前无条件调用。
  const [dismissed, setDismissed] = useState(false);

  const lifecycleTip = LIFECYCLE_TIPS[phase];
  if (lifecycleTip) {
    return <LifecyclePhaseTip phase={phase} config={lifecycleTip} />;
  }

  if (hasMessages) return null;
  if (dismissed) return null;
  const cat = catName ?? '猫猫';
  const tipFn = PHASE_TIPS[phase];
  if (!tipFn) return null;
  const tip = tipFn(cat);

  return (
    <>
      {/*
        视觉遮罩：仅用于聚焦输入框。刻意 pointer-events-none —— 之前用 pointerEvents:'auto'
        全屏拦截，靠 z-index 把输入框「打洞」露出来，但输入框深埋在多层容器里，一旦某个祖先
        形成独立层叠上下文，z-index 抬升就失效、输入框被遮罩盖住，用户会被彻底困死、无法操作。
        改为不拦截指针后，遮罩只做视觉压暗，输入框及其它元素始终可交互。
      */}
      <div className="pointer-events-none fixed inset-0 z-[60] bg-[var(--console-overlay-backdrop)]" />
      <style>{`[data-bootcamp-step="chat-input"] { position: relative; z-index: 65 !important; }`}</style>
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[66]">
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-conn-amber-ring bg-conn-amber-bg px-5 py-3 shadow-xl animate-fade-in">
          <span className="text-lg">👇</span>
          <span className="text-sm font-medium text-conn-amber-text">{tip}</span>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="关闭引导提示"
            className="ml-2 rounded-md px-1.5 text-base leading-none text-conn-amber-text/60 transition-colors hover:text-conn-amber-text"
          >
            ✕
          </button>
        </div>
      </div>
    </>
  );
}
