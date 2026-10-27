import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Relation } from '../api';
import { useI18n } from '../i18n';

interface FileNodeData extends Record<string, unknown> {
  label: string;
  dir: string;
  findings: number;
  highRisk: number;
  incoming: number;
}

function FileNode({ data, selected }: NodeProps<Node<FileNodeData>>) {
  const tone = data.highRisk > 0 ? 'var(--high)' : data.findings > 0 ? 'var(--medium)' : 'var(--border-strong)';
  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${selected ? 'var(--accent)' : tone}`,
        borderLeft: `3px solid ${tone}`,
        borderRadius: 8,
        padding: '7px 10px',
        minWidth: 168,
        boxShadow: selected ? '0 0 0 2px var(--accent-soft)' : '0 1px 2px rgba(16,24,40,.06)',
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>{data.label}</span>
        {data.findings > 0 ? (
          <span
            className="badge"
            style={{
              background: data.highRisk > 0 ? 'var(--high-soft)' : 'var(--medium-soft)',
              color: data.highRisk > 0 ? 'var(--high)' : 'var(--medium)',
              fontSize: 10,
              padding: '0 5px',
              lineHeight: '15px',
            }}
          >
            {data.findings}
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 168 }}>
        {data.dir || '.'}
      </div>
    </div>
  );
}

const nodeTypes = { file: FileNode };

/** Layered left-to-right layout: depth = shortest distance from a page that references nothing. */
function layout(nodes: string[], relations: Relation[]): Map<string, { x: number; y: number }> {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node, 0);
  for (const relation of relations) {
    if (!incoming.has(relation.fromPath) || !incoming.has(relation.toPath)) continue;
    incoming.set(relation.toPath, (incoming.get(relation.toPath) ?? 0) + 1);
    const list = outgoing.get(relation.fromPath) ?? [];
    list.push(relation.toPath);
    outgoing.set(relation.fromPath, list);
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    if ((incoming.get(node) ?? 0) === 0) {
      depth.set(node, 0);
      queue.push(node);
    }
  }
  if (queue.length === 0 && nodes.length > 0) {
    depth.set(nodes[0], 0);
    queue.push(nodes[0]);
  }

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const base = depth.get(current) ?? 0;
    for (const next of outgoing.get(current) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, Math.min(base + 1, 5));
      queue.push(next);
    }
  }

  const columns = new Map<number, string[]>();
  for (const node of nodes) {
    const level = depth.get(node) ?? 3;
    const list = columns.get(level) ?? [];
    list.push(node);
    columns.set(level, list);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, list] of columns) {
    list.sort();
    list.forEach((node, index) => {
      positions.set(node, { x: level * 260, y: index * 92 });
    });
  }
  return positions;
}

export function DependencyGraph({
  relations,
  findingsByFile,
  onSelectFile,
  selectedFile,
  maxNodes = 60,
}: {
  relations: Relation[];
  findingsByFile: Map<string, { total: number; high: number }>;
  onSelectFile: (path: string | null) => void;
  selectedFile: string | null;
  maxNodes?: number;
}) {
  const { t } = useI18n();
  const [focus, setFocus] = useState<string | null>(null);

  const { nodes, edges, truncated } = useMemo(() => {
    const visibleRelations = focus ? relations.filter((rel) => rel.fromPath === focus || rel.toPath === focus) : relations;
    const paths: string[] = [];
    for (const relation of visibleRelations) {
      if (!paths.includes(relation.fromPath)) paths.push(relation.fromPath);
      if (!paths.includes(relation.toPath)) paths.push(relation.toPath);
    }
    const limited = paths.slice(0, maxNodes);
    const positions = layout(limited, visibleRelations);

    const flowNodes: Array<Node<FileNodeData>> = limited.map((path) => {
      const stats = findingsByFile.get(path) ?? { total: 0, high: 0 };
      const segments = path.split('/');
      return {
        id: path,
        type: 'file',
        position: positions.get(path) ?? { x: 0, y: 0 },
        selected: path === selectedFile,
        data: {
          label: segments[segments.length - 1],
          dir: segments.slice(0, -1).join('/'),
          findings: stats.total,
          highRisk: stats.high,
          incoming: 0,
        },
      };
    });

    const flowEdges: Edge[] = visibleRelations
      .filter((rel) => limited.includes(rel.fromPath) && limited.includes(rel.toPath))
      .map((rel, index) => ({
        id: `${rel.fromPath}->${rel.toPath}-${rel.kind}-${index}`,
        source: rel.fromPath,
        target: rel.toPath,
        animated: rel.confidence === 'UNKNOWN',
        style: {
          stroke: rel.confidence === 'CONFIRMED' ? '#8b93a3' : rel.confidence === 'INFERRED' ? '#b48a3a' : '#c0271d',
          strokeWidth: 1.3,
          strokeDasharray: rel.confidence === 'CONFIRMED' ? undefined : rel.confidence === 'INFERRED' ? '4 3' : '2 3',
        },
        markerEnd: { type: 'arrowclosed' as const, width: 14, height: 14, color: rel.confidence === 'UNKNOWN' ? '#c0271d' : '#8b93a3' },
        label: rel.kind === 'SHARED_FUNCTION_CALL' ? 'call' : undefined,
        labelStyle: { fontSize: 9, fill: '#78808f' },
      }));

    return { nodes: flowNodes, edges: flowEdges, truncated: paths.length > limited.length };
  }, [relations, findingsByFile, focus, selectedFile, maxNodes]);

  useEffect(() => {
    setFocus(null);
  }, [relations]);

  const handleNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      onSelectFile(node.id as string);
    },
    [onSelectFile],
  );

  return (
    <div className="graph-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={() => onSelectFile(null)}
        fitView
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
      >
        <Background gap={16} color="#e6e9ef" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {truncated ? (
        <div style={{ position: 'absolute', bottom: 8, right: 10, fontSize: 11, color: 'var(--text-3)' }}>
          {t('deps.filter')}: {nodes.length} / {relations.length}
        </div>
      ) : null}
    </div>
  );
}
