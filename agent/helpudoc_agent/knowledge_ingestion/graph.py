"""Deterministic NetworkX graph analysis for canonical Knowledge concepts."""
from __future__ import annotations

from typing import Any

import networkx as nx


def analyze_canonical_graph(concepts: list[dict[str, Any]]) -> dict[str, Any]:
    graph = nx.DiGraph()
    names: dict[str, str] = {}
    for concept in concepts:
        concept_id = str(concept.get("id") or "")
        if not concept_id:
            continue
        names[concept_id] = str(concept.get("name") or concept_id)
        graph.add_node(concept_id, kind=str(concept.get("kind") or "Concept"))
    for concept in concepts:
        source = str(concept.get("id") or "")
        for relationship in concept.get("relationships") or []:
            target = str(relationship.get("targetId") or "")
            if source in graph and target in graph:
                graph.add_edge(
                    source,
                    target,
                    type=str(relationship.get("type") or "related_to"),
                    confidence=float(relationship.get("confidence") or 0),
                )
    undirected = graph.to_undirected()
    components = [sorted(component) for component in nx.connected_components(undirected)]
    components.sort(key=lambda component: (-len(component), component))
    if graph.number_of_nodes() and graph.number_of_edges():
        louvain = list(nx.community.louvain_communities(undirected, seed=0, weight=None))
    else:
        louvain = [{node} for node in sorted(graph.nodes)]
    degree = nx.degree_centrality(undirected) if graph.number_of_nodes() > 1 else {
        node: 0.0 for node in graph.nodes
    }
    communities = []
    for index, members in enumerate(sorted((sorted(group) for group in louvain), key=lambda group: (-len(group), group)), start=1):
        representative = sorted(members, key=lambda node: (-degree.get(node, 0), names.get(node, node)))[:3]
        communities.append({
            "id": f"community-{index}",
            "label": " / ".join(names.get(node, node) for node in representative),
            "conceptIds": members,
            "size": len(members),
        })
    return {
        "algorithm": "networkx-louvain",
        "algorithmVersion": f"networkx/{nx.__version__}:louvain-seed-0",
        "nodeCount": graph.number_of_nodes(),
        "edgeCount": graph.number_of_edges(),
        "density": nx.density(graph) if graph.number_of_nodes() > 1 else 0.0,
        "components": components,
        "componentCount": len(components),
        "orphanIds": sorted(node for node in graph.nodes if graph.degree(node) == 0),
        "centrality": {node: round(score, 8) for node, score in sorted(degree.items())},
        "communities": communities,
    }
