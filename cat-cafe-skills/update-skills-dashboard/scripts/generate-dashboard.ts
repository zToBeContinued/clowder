#!/usr/bin/env tsx
/**
 * Generate Skills Dashboard HTML
 * 扫描本地 skill 目录，生成 dashboard HTML 文件
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SkillMeta {
  name: string;
  description: string;
  triggers?: string[];
  path: string;
  source: 'personal' | 'clowder' | 'codex404';
  risk: 'low' | 'medium' | 'high';
  category: string;
}

// 解析项目根目录（从脚本位置向上找 .git）
function findProjectRoot(): string {
  let current = __dirname;
  while (current !== '/') {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    current = dirname(current);
  }
  return process.cwd(); // fallback
}

const PROJECT_ROOT = findProjectRoot();

const SKILL_SOURCES = [
  { name: 'personal', path: join(homedir(), '.agents/skills'), label: '个人主力' },
  { name: 'clowder', path: join(PROJECT_ROOT, 'cat-cafe-skills'), label: 'Clowder 可用' },
  // 可扩展更多源
];

const OUTPUT_PATH = '~/Documents/03 life/AI design/产品项目/skill管理/skills-dashboard.html';

async function extractSkillMeta(skillPath: string, source: string): Promise<SkillMeta | null> {
  try {
    const mdPath = join(skillPath, 'SKILL.md');
    const content = await readFile(mdPath, 'utf-8');

    // 提取 frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return null;

    const frontmatter = frontmatterMatch[1];
    const nameMatch = frontmatter.match(/name:\s*(.+)/);
    const descMatch = frontmatter.match(/description:\s*[>|]?\s*(.+?)(?=\ntriggers:|$)/s);
    const triggersMatch = frontmatter.match(/triggers:\s*\n((?:\s*-\s*.+\n?)+)/);

    if (!nameMatch || !descMatch) return null;

    const name = nameMatch[1].trim();
    const description = descMatch[1].trim().replace(/\n\s*/g, ' ');
    const triggers = triggersMatch
      ? triggersMatch[1]
          .split('\n')
          .map((t) => t.trim().replace(/^-\s*/, ''))
          .filter(Boolean)
      : [];

    // 推断分类和风险
    const category = inferCategory(name, description, triggers);
    const risk = inferRisk(description);

    return {
      name,
      description,
      triggers,
      path: skillPath,
      source: source as any,
      risk,
      category,
    };
  } catch {
    return null;
  }
}

function inferCategory(name: string, desc: string, triggers: string[]): string {
  const text = `${name} ${desc} ${triggers.join(' ')}`.toLowerCase();

  if (text.match(/开发|代码|test|tdd|debug|worktree/)) return '工程开发';
  if (text.match(/产品|feature|prd|需求/)) return '产品工作';
  if (text.match(/调研|research|文档/)) return '研究资料';
  if (text.match(/设计|design|ui|ux/)) return '设计产出';
  if (text.match(/agent|skill|mcp/)) return 'Agent 基建';
  if (text.match(/飞书|企微|lark|wecom/)) return '平台集成';

  return '其他';
}

function inferRisk(desc: string): 'low' | 'medium' | 'high' {
  if (desc.match(/删除|delete|drop|force|reset|危险/i)) return 'high';
  if (desc.match(/修改|update|merge|commit/i)) return 'medium';
  return 'low';
}

async function scanSkills(): Promise<SkillMeta[]> {
  const allSkills: SkillMeta[] = [];

  for (const source of SKILL_SOURCES) {
    try {
      const entries = await readdir(source.path, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = join(source.path, entry.name);
        const meta = await extractSkillMeta(skillPath, source.name);

        if (meta) {
          allSkills.push(meta);
        }
      }
    } catch (err) {
      console.warn(`Warning: Failed to scan ${source.name} at ${source.path}`);
    }
  }

  return allSkills.sort((a, b) => a.name.localeCompare(b.name));
}

async function generateHTML(skills: SkillMeta[]): Promise<string> {
  // 读取现有模板（保留样式和双语标题逻辑）
  const templatePath = OUTPUT_PATH;
  let template: string;

  try {
    template = await readFile(templatePath, 'utf-8');
  } catch {
    // 如果文件不存在，使用简化模板
    template = await readFile(join(__dirname, '../assets/template.html'), 'utf-8');
  }

  // 提取样式和脚本部分（保留现有实现）
  const styleMatch = template.match(/<style>([\s\S]*?)<\/style>/);
  const scriptMatch = template.match(/<script>([\s\S]*?)<\/script>/);

  const styles = styleMatch ? styleMatch[1] : '';
  const scripts = scriptMatch ? scriptMatch[1] : '';

  // 生成技能数据 JSON
  const skillsJSON = JSON.stringify(skills, null, 2);

  // 生成统计数据
  const stats = {
    total: skills.length,
    clowder: skills.filter((s) => s.source === 'clowder').length,
    personal: skills.filter((s) => s.source === 'personal').length,
    highRisk: skills.filter((s) => s.risk === 'high').length,
  };

  // 重新组装 HTML（保留双语标题逻辑）
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Skill 仪表板 · Skills Dashboard</title>
  <style>${styles}</style>
</head>
<body>
  <div class="header">
    <div class="badge">Skills Dashboard</div>
    <h1>Skill 仪表板 · Skills Dashboard</h1>
    <p class="subtitle">按使用场景整理本地主力 skill · Scenario-based map of reusable AI skills。后续 skills-manifest.json 会给 Clowder Skill Router 作为轻量菜单。</p>
    <div class="controls">
      <input type="text" id="search" placeholder="搜索名称、描述、触发词、路径 / Search skills...">
      <select id="categoryFilter"><option value="">全部场景</option></select>
      <select id="sourceFilter"><option value="">全部来源</option></select>
    </div>
  </div>
  <main>
    <div class="stats">
      <div class="stat"><strong>${stats.total}</strong><span>总 Skill</span></div>
      <div class="stat"><strong>${stats.clowder}</strong><span>Clowder 可用</span></div>
      <div class="stat"><strong>${stats.personal}</strong><span>个人主力</span></div>
      <div class="stat"><strong>${stats.highRisk}</strong><span>中高风险</span></div>
    </div>
    <div id="skillsContainer"></div>
  </main>
  <script>
    const SKILLS = ${skillsJSON};
    ${scripts}
  </script>
</body>
</html>`;
}

async function main() {
  console.log('Scanning skill directories...');
  const skills = await scanSkills();

  console.log(`Found ${skills.length} skills`);
  console.log(`  - Clowder: ${skills.filter((s) => s.source === 'clowder').length}`);
  console.log(`  - Personal: ${skills.filter((s) => s.source === 'personal').length}`);

  console.log('Generating HTML...');
  const html = await generateHTML(skills);

  console.log(`Writing to ${OUTPUT_PATH}...`);
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, html, 'utf-8');

  console.log('✅ Skills Dashboard updated successfully!');
  console.log(`   Visit: http://localhost:3003/api/skills/dashboard`);
}

main().catch(console.error);
