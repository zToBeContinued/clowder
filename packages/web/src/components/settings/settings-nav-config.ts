export type SettingsSectionGroup = 'basic' | 'advanced' | 'experimental';

export interface SettingsSection {
  id: string;
  label: string;
  icon: string;
  color: string;
  description: string;
  group: SettingsSectionGroup;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'members',
    label: '成员管理',
    icon: 'users',
    color: 'var(--color-opus-primary)',
    description: '成员名册、默认协作对象与编排顺序。',
    group: 'basic',
  },
  {
    id: 'accounts',
    label: '账户与密钥',
    icon: 'key',
    color: 'var(--color-opus-primary)',
    description: '模型账户、凭据和执行身份的归属关系。',
    group: 'basic',
  },
  {
    id: 'cli-runtime',
    label: 'CLI 运行环境',
    icon: 'terminal',
    color: 'var(--cafe-accent)',
    description: '管理仅存于本机的 CLI command override 与代理环境变量，并按成员独立绑定。',
    group: 'advanced',
  },
  {
    id: 'im',
    label: 'IM 对接',
    icon: 'plug',
    color: 'var(--cafe-accent)',
    description: '飞书、钉钉、企微和外部消息入口。',
    group: 'basic',
  },
  {
    id: 'skills',
    label: 'Skill 管理',
    icon: 'zap',
    color: 'var(--cafe-accent)',
    description: '技能市场、安装计划和本地能力预览。',
    group: 'basic',
  },
  {
    id: 'mcp',
    label: 'MCP 管理',
    icon: 'box',
    color: 'var(--cafe-accent)',
    description: 'MCP 服务、工具目录和安全网开关；真实边界仍由 OS/远端权限决定。',
    group: 'advanced',
  },
  {
    id: 'plugins',
    label: '插件/集成',
    icon: 'puzzle',
    color: 'var(--cafe-accent)',
    description: '插件状态、外部集成以及安装结果。',
    group: 'advanced',
  },
  {
    id: 'marketplace',
    label: '能力市场',
    icon: 'search',
    color: 'var(--cafe-accent)',
    description: '搜索安装能力包，安装前预览来源、权限风险和确认流程。',
    group: 'advanced',
  },
  {
    id: 'voice',
    label: '语音管理',
    icon: 'mic',
    color: 'var(--color-gemini-primary)',
    description: '语音输入输出、术语表和 TTS 服务状态。',
    group: 'basic',
  },
  {
    id: 'system',
    label: '系统配置',
    icon: 'settings',
    color: 'var(--color-gemini-primary)',
    description: '环境选项、默认行为和运行时总开关。',
    group: 'basic',
  },
  {
    id: 'rules',
    label: '规则与 SOP',
    icon: 'file-text',
    color: 'var(--color-gemini-primary)',
    description: '家规、协作 SOP 和模型提示词入口。',
    group: 'basic',
  },
  {
    id: 'notify',
    label: '通知',
    icon: 'bell',
    color: 'var(--color-gemini-primary)',
    description: '推送订阅、提醒策略与设备联动。',
    group: 'basic',
  },
  {
    id: 'ops',
    label: '运维监控',
    icon: 'activity',
    color: 'var(--color-gemini-primary)',
    description: '服务健康、命令工具和运行态观测。',
    group: 'advanced',
  },
];

export const SETTINGS_GROUP_LABELS: Record<SettingsSectionGroup, string> = {
  basic: '基础设置',
  advanced: '高级',
  experimental: '实验区',
};

export function isDailySettingsSection(section: SettingsSection): boolean {
  return section.group === 'basic';
}

export const DEFAULT_SECTION = 'members';
