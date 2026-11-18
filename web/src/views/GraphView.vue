<script setup lang="ts">
/**
 * 兴趣图谱 —— W1 核心可视化。
 *
 * 手写 SVG 力导向图，不引第三方图库（spec §5）：
 *   节点大小 = 权重、颜色 = 分类、边按关系区分线型；
 *   点击节点 → 证据面板（来源 + 原文 + 时间，动态/小组可跳转溯源）；
 *   窄屏（< 768px）降级为按分类分组的标签云，不做移动端力导向图。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { graphApi } from '@/api';
import { useToast } from '@/lib/toast';
import type { GraphEdge, GraphEvidence, GraphNode } from '@/types';

const { error } = useToast();

const loading = ref(true);
const nodes = ref<GraphNode[]>([]);
const edges = ref<GraphEdge[]>([]);
const selected = ref<GraphNode | null>(null);

/* 窄屏检测：matchMedia 变化时切到标签云 */
const mq = window.matchMedia('(max-width: 767px)');
const isNarrow = ref(mq.matches);
const onMq = () => {
  isNarrow.value = mq.matches;
};

onMounted(() => {
  mq.addEventListener('change', onMq);
  load();
});
onUnmounted(() => mq.removeEventListener('change', onMq));

async function load() {
  loading.value = true;
  try {
    const res = await graphApi.own();
    nodes.value = res.graph.nodes;
    edges.value = res.graph.edges;
    selected.value = nodes.value[0] || null;
  } catch (e: any) {
    error(e?.message || '图谱加载失败');
  } finally {
    loading.value = false;
  }
}

/* ---------------- 力导向布局 ---------------- */

const W = 880;
const H = 540;

interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  node: GraphNode;
}

/**
 * 斥力 + 边引力 + 向心力，固定迭代收敛到稳定布局。
 * 初始位置按序号绕圈摆开（不引随机数，保证每次渲染布局一致）。
 */
const layout = computed(() => {
  const ns: SimNode[] = nodes.value.map((n, i) => {
    const angle = (i / Math.max(1, nodes.value.length)) * Math.PI * 2;
    return {
      id: n.id,
      x: W / 2 + Math.cos(angle) * 190,
      y: H / 2 + Math.sin(angle) * 150,
      vx: 0,
      vy: 0,
      node: n,
    };
  });
  const byId = new Map(ns.map((s) => [s.id, s]));
  const links: { a: SimNode; b: SimNode; type: string }[] = [];
  for (const e of edges.value) {
    const a = byId.get(e.from_node);
    const b = byId.get(e.to_node);
    if (a && b) links.push({ a, b, type: e.type });
  }

  for (let tick = 0; tick < 280; tick += 1) {
    const cool = 1 - tick / 280; // 逐渐降温，末期不再大挪移

    // 两两斥力（平方反比），防止节点重叠
    for (let i = 0; i < ns.length; i += 1) {
      for (let j = i + 1; j < ns.length; j += 1) {
        const a = ns[i];
        const b = ns[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        dx /= d;
        dy /= d;
        const f = 5600 / d2;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
    }

    // 边引力：把有关系的节点拉到目标距离附近
    for (const l of links) {
      const dx = l.b.x - l.a.x;
      const dy = l.b.y - l.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - 115) * 0.022;
      l.a.vx += (dx / d) * f;
      l.a.vy += (dy / d) * f;
      l.b.vx -= (dx / d) * f;
      l.b.vy -= (dy / d) * f;
    }

    // 向心力 + 阻尼 + 位置更新（限步防飞出画布）
    for (const s of ns) {
      s.vx += (W / 2 - s.x) * 0.006;
      s.vy += (H / 2 - s.y) * 0.006;
      s.vx *= 0.82;
      s.vy *= 0.82;
      s.x += Math.max(-9, Math.min(9, s.vx)) * cool + s.vx * (1 - cool) * 0.3;
      s.y += Math.max(-9, Math.min(9, s.vy)) * cool + s.vy * (1 - cool) * 0.3;
    }
  }

  // 节点收进画布内，留出发标签的边距
  for (const s of ns) {
    s.x = Math.max(46, Math.min(W - 46, s.x));
    s.y = Math.max(34, Math.min(H - 42, s.y));
  }
  return { ns, links, byId };
});

/* 节点样式：大小 = 权重，颜色 = 分类 */
function radiusOf(n: GraphNode) {
  return 9 + n.weight * 0.24;
}

/** 14 类固定配色（沿用品牌色系），未知/自动节点归灰色 */
const PALETTE: Record<string, string> = {
  编程开发: '#0b8579',
  人工智能: '#0ea5e9',
  数学物理: '#6366f1',
  阅读写作: '#8b5cf6',
  影视音乐: '#d946ef',
  游戏电竞: '#ec4899',
  运动健身: '#f97316',
  摄影设计: '#eab308',
  志愿公益: '#22c55e',
  创业商业: '#14b8a6',
  语言学习: '#06b6d4',
  美食生活: '#f59e0b',
  学术科研: '#3b82f6',
  心理健康: '#10b981',
  其他: '#94a3b8',
};
const colorOf = (cat: string) => PALETTE[cat] || PALETTE['其他'];

/** 边样式：sub_of 实线、related 虚线、co_occurs 细线 */
const EDGE_STYLE: Record<string, { dash: string; width: number; opacity: number }> = {
  sub_of: { dash: '', width: 2, opacity: 0.7 },
  related: { dash: '7 5', width: 1.6, opacity: 0.6 },
  co_occurs: { dash: '', width: 1, opacity: 0.35 },
};

/* ---------------- 证据面板辅助 ---------------- */

const SOURCE_LABEL: Record<string, string> = {
  interview: '访谈',
  post: '动态',
  profile: '个人简介',
  group: '兴趣小组',
};

function evLink(e: GraphEvidence): string | null {
  if (e.source_type === 'post' && e.source_id) return `/post/${e.source_id}`;
  if (e.source_type === 'group' && e.source_id) return `/group/${e.source_id}`;
  return null; // 访谈证据是 vN 版本号，简介是本人，都不值得跳
}

function fmtTime(at: number) {
  return new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 标签云：按分类分组 */
const byCategory = computed(() => {
  const map = new Map<string, GraphNode[]>();
  for (const n of nodes.value) {
    const list = map.get(n.category) || [];
    list.push(n);
    map.set(n.category, list);
  }
  return [...map.entries()].map(([cat, list]) => ({
    cat,
    list: [...list].sort((a, b) => b.weight - a.weight),
  }));
});

const edgeLegend = [
  { type: 'sub_of', label: '从属' },
  { type: 'related', label: '关联' },
  { type: 'co_occurs', label: '共现' },
];
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">兴趣图谱</h1>
        <p class="page-sub">AI 从你的访谈、动态、简介里持续抽取兴趣节点。节点越大权重越高，点开看证据。</p>
      </div>
      <RouterLink to="/persona" class="btn ghost sm">返回画像</RouterLink>
    </div>

    <div v-if="loading" class="skeleton" style="height: 420px" />

    <!-- 空态 -->
    <div v-else-if="!nodes.length" class="card pad-lg center">
      <div class="empty-ico">🕸️</div>
      <h3>图谱还空着</h3>
      <p class="muted" style="max-width: 420px; margin: 0 auto 16px">
        完成一次访谈、发条带兴趣的动态，或者完善个人简介，节点就会长出来。
      </p>
      <div class="row wrap" style="justify-content: center">
        <RouterLink to="/persona" class="btn">去做画像访谈</RouterLink>
        <RouterLink to="/community" class="btn ghost">去发条动态</RouterLink>
      </div>
    </div>

    <template v-else>
      <!-- 桌面端：力导向图 + 证据面板 -->
      <div v-if="!isNarrow" class="graph-wrap">
        <div class="card graph-canvas">
          <svg :viewBox="`0 0 ${W} ${H}`" class="graph-svg">
            <!-- 边 -->
            <line
              v-for="(l, i) in layout.links"
              :key="'e' + i"
              :x1="l.a.x"
              :y1="l.a.y"
              :x2="l.b.x"
              :y2="l.b.y"
              :stroke="selected && (l.a.id === selected.id || l.b.id === selected.id) ? '#0b8579' : '#8aa8a2'"
              :stroke-width="EDGE_STYLE[l.type]?.width ?? 1"
              :stroke-dasharray="EDGE_STYLE[l.type]?.dash || undefined"
              :opacity="selected ? (l.a.id === selected.id || l.b.id === selected.id ? 0.9 : 0.18) : (EDGE_STYLE[l.type]?.opacity ?? 0.4)"
            />
            <!-- 节点 -->
            <g
              v-for="s in layout.ns"
              :key="s.id"
              class="node-g"
              :class="{ on: selected?.id === s.id }"
              @click="selected = s.node"
            >
              <circle
                :cx="s.x"
                :cy="s.y"
                :r="radiusOf(s.node)"
                :fill="colorOf(s.node.category)"
                :opacity="selected && selected.id !== s.id ? 0.55 : 0.92"
                :stroke="selected?.id === s.id ? '#12332e' : '#ffffff'"
                :stroke-width="selected?.id === s.id ? 3 : 1.5"
              />
              <text :x="s.x" :y="s.y + radiusOf(s.node) + 14" text-anchor="middle" class="node-label">
                {{ s.node.name }}
              </text>
            </g>
          </svg>

          <div class="graph-legend tiny muted">
            <span v-for="e in edgeLegend" :key="e.type" class="legend-item">
              <svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" :stroke="'#8aa8a2'" :stroke-width="EDGE_STYLE[e.type]?.width" :stroke-dasharray="EDGE_STYLE[e.type]?.dash || undefined" /></svg>
              {{ e.label }}
            </span>
            <span class="legend-item">节点大小 = 权重</span>
          </div>
        </div>

        <!-- 证据面板 -->
        <div class="card pad-lg evidence-panel">
          <template v-if="selected">
            <div class="row between">
              <h3 class="mb-0">{{ selected.name }}</h3>
              <span class="tag brand">{{ selected.category }}</span>
            </div>
            <p class="muted small mb-1">
              权重 <b>{{ selected.weight }}</b> / 100 ·
              {{ selected.status === 'auto' ? '自动创建节点' : '规范节点' }} ·
              最近更新 {{ fmtTime(selected.updated_at) }}
            </p>
            <div class="divider" />
            <h4 class="small bold mb-2">证据来源（{{ selected.evidence.length }}）</h4>
            <div v-if="!selected.evidence.length" class="dim small">暂无证据明细</div>
            <div v-for="(e, i) in selected.evidence" :key="i" class="evidence-item">
              <div class="row between tiny">
                <span class="tag sm">{{ SOURCE_LABEL[e.source_type] || e.source_type }}</span>
                <span class="dim">{{ fmtTime(e.at) }}</span>
              </div>
              <p class="small mb-0">「{{ e.quote }}」</p>
              <RouterLink v-if="evLink(e)" :to="evLink(e)!" class="tiny link">查看来源 →</RouterLink>
            </div>
          </template>
          <div v-else class="dim small">点击图中的节点查看证据来源</div>
        </div>
      </div>

      <!-- 窄屏：标签云降级 -->
      <div v-else>
        <div class="alert info mb-2">小屏下图谱以标签云展示，电脑端打开可见完整关系图。</div>
        <div v-for="g in byCategory" :key="g.cat" class="card pad-lg mb-2">
          <div class="row between mb-1">
            <h4 class="mb-0 small bold">{{ g.cat }}</h4>
            <span class="tiny dim">{{ g.list.length }} 个节点</span>
          </div>
          <div class="tag-row">
            <button
              v-for="n in g.list"
              :key="n.id"
              class="tag brand cloud-tag"
              :class="{ on: selected?.id === n.id }"
              @click="selected = n"
            >
              {{ n.name }} · {{ n.weight }}
            </button>
          </div>
        </div>

        <!-- 选中节点的证据（窄屏放在标签云下方） -->
        <div v-if="selected" class="card pad-lg">
          <div class="row between">
            <h3 class="mb-0">{{ selected.name }}</h3>
            <span class="tag brand">{{ selected.category }}</span>
          </div>
          <p class="muted small">权重 <b>{{ selected.weight }}</b> / 100</p>
          <div class="divider" />
          <div v-for="(e, i) in selected.evidence" :key="i" class="evidence-item">
            <div class="row between tiny">
              <span class="tag sm">{{ SOURCE_LABEL[e.source_type] || e.source_type }}</span>
              <span class="dim">{{ fmtTime(e.at) }}</span>
            </div>
            <p class="small mb-0">「{{ e.quote }}」</p>
            <RouterLink v-if="evLink(e)" :to="evLink(e)!" class="tiny link">查看来源 →</RouterLink>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.graph-wrap {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 16px;
  align-items: start;
}
.graph-canvas {
  padding: 8px;
}
.graph-svg {
  width: 100%;
  height: auto;
  display: block;
}
.node-g {
  cursor: pointer;
}
.node-g:hover circle {
  filter: brightness(1.08);
}
.node-label {
  font-size: 12px;
  fill: var(--text-2);
  pointer-events: none;
}
.node-g.on .node-label {
  fill: var(--text);
  font-weight: 700;
}
.graph-legend {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  padding: 4px 8px 6px;
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.evidence-panel {
  position: sticky;
  top: 16px;
}
.evidence-item {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.evidence-item:last-child {
  border-bottom: none;
}
.cloud-tag.on {
  outline: 2px solid var(--brand-600);
}
@media (max-width: 960px) {
  .graph-wrap {
    grid-template-columns: 1fr;
  }
}
</style>
