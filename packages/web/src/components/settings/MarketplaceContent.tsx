'use client';

import { MarketplacePanel } from '../marketplace/marketplace-panel';
import { SettingsPageHeader } from './SettingsPageHeader';

export function MarketplaceContent() {
  return (
    <div className="space-y-5">
      <SettingsPageHeader title="能力市场" subtitle="安装前先看来源和权限风险；Clowder 只提供预览、确认和审计安全网" />
      <MarketplacePanel />
    </div>
  );
}
