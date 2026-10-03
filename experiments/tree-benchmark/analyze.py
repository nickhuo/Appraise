# /// script
# requires-python = ">=3.10"
# dependencies = ["tiktoken==0.14.0"]
# ///
"""Measure observation payloads and information retention without model calls."""

import argparse
import hashlib
import json
import re
import statistics
import xml.etree.ElementTree as ET
from pathlib import Path

import tiktoken


def visible_nodes(source: str) -> list[ET.Element]:
    nodes = []
    for node in ET.fromstring(source).iter():
        attributes = node.attrib
        if not attributes.get("class") or attributes.get("displayed") == "false":
            continue
        if attributes.get("package") == "com.android.systemui" or "inputmethod" in attributes.get("package", ""):
            continue
        bounds = [int(value) for value in re.findall(r"-?\d+", attributes.get("bounds", ""))]
        if len(bounds) == 4 and bounds[2] > bounds[0] and bounds[3] > bounds[1]:
            nodes.append(node)
    return nodes


def labels(nodes: list[ET.Element]) -> list[str]:
    return list(dict.fromkeys(
        value.strip() for node in nodes for key in ("text", "content-desc", "hint")
        if (value := node.get(key, "")).strip()
    ))


def compact(nodes: list[ET.Element], *, context: bool) -> tuple[str, int]:
    lines = []
    included_labels: set[str] = set()
    visible_ids = {id(node) for node in nodes}
    for index, node in enumerate(nodes):
        roles = []
        if node.get("clickable") == "true":
            roles.append("tap")
        if context:
            if node.get("checkable") == "true":
                roles.append("toggle")
            if node.get("class", "").endswith("EditText") or node.get("editable") == "true":
                roles.append("type")
            if node.get("scrollable") == "true":
                roles.append("scroll")
            if node.get("long-clickable") == "true":
                roles.append("longpress")
        if not roles:
            continue
        # A tappable parent often gets its label from non-tappable children.
        names = labels([child for child in node.iter() if id(child) in visible_ids])
        included_labels.update(names)
        flags = [key for key in ("selected", "focused") if node.get(key) == "true"]
        if node.get("checkable") == "true":
            flags.append("checked" if node.get("checked") == "true" else "unchecked")
        if node.get("enabled") == "false":
            flags.append("disabled")
        bounds = [int(value) for value in re.findall(r"-?\d+", node.get("bounds", ""))]
        line = f"@{index + 1} {'/'.join(roles)} {json.dumps(names, ensure_ascii=False)} bounds={','.join(map(str, bounds))}"
        lines.append(" ".join([line, *flags]))
    action_count = len(lines)
    if context:
        lines.extend(f"text {json.dumps(label, ensure_ascii=False)}" for label in labels(nodes) if label not in included_labels)
    return "\n".join(lines), action_count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("data/tree-benchmark"))
    parser.add_argument("--encoding", default="o200k_base")
    args = parser.parse_args()
    encoder = tiktoken.get_encoding(args.encoding)
    corpus = json.loads((args.directory / "current-model-corpus.json").read_text())
    rows = []
    seen: set[str] = set()
    for record in corpus:
        source = Path(record["source"]).read_text()
        digest = hashlib.sha256(source.encode()).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        nodes = visible_nodes(source)
        click_text, click_count = compact(nodes, context=False)
        context_text, action_count = compact(nodes, context=True)
        all_labels = labels(nodes)
        # Parse quoted strings so escaping does not make a retained label look lost.
        click_labels = set()
        for line in click_text.splitlines():
            click_labels.update(json.loads(line[line.index("["):line.rindex("]") + 1]))
        missing_labels = [label for label in all_labels if label not in click_labels]
        payloads = {"raw_xml": source, "current_model": record["text"], "clickable_only": click_text, "actions_context": context_text}
        rows.append({
            "app": record["app"], "source": record["source"], "sha256": digest,
            "tokens": {name: len(encoder.encode(text, disallowed_special=())) for name, text in payloads.items()},
            "visible_nodes": len(nodes), "clickable_nodes": click_count, "actionable_nodes": action_count,
            "label_count": len(all_labels), "clickable_missing_labels": missing_labels,
            "missed_inputs": sum(node.get("clickable") != "true" and (node.get("class", "").endswith("EditText") or node.get("editable") == "true") for node in nodes),
            "missed_scrollers": sum(node.get("clickable") != "true" and node.get("scrollable") == "true" for node in nodes),
        })
    live = []
    for directory in sorted(args.directory.iterdir()):
        if not (directory / "mobile.txt").is_file():
            continue
        source = (directory / "appium.xml").read_text()
        before_nodes = visible_nodes(source)
        after_nodes = visible_nodes((directory / "appium-after.xml").read_text())
        click_text, _ = compact(before_nodes, context=False)
        context_text, _ = compact(before_nodes, context=True)
        (directory / "clickable.txt").write_text(click_text)
        (directory / "actions-context.txt").write_text(context_text)
        mobile_elements = json.loads((directory / "mobile-elements.json").read_text())
        mobile_labels = {str(element[key]).strip() for element in mobile_elements for key in ("text", "label", "name", "value") if element.get(key)}
        source_labels = labels(before_nodes)
        before_keys = {(node.get("class"), node.get("resource-id"), node.get("bounds"), node.get("text"), node.get("content-desc")) for node in before_nodes}
        after_keys = {(node.get("class"), node.get("resource-id"), node.get("bounds"), node.get("text"), node.get("content-desc")) for node in after_nodes}
        mobile_text = (directory / "mobile.txt").read_text()
        status_bars = [element["rect"] for element in mobile_elements if element.get("identifier") == "com.android.systemui:id/status_bar"]
        removed_refs = set()
        for element in mobile_elements:
            rect = element["rect"]
            if any(rect["x"] >= bar["x"] and rect["y"] >= bar["y"]
                   and rect["x"] + rect["width"] <= bar["x"] + bar["width"]
                   and rect["y"] + rect["height"] <= bar["y"] + bar["height"] for bar in status_bars):
                removed_refs.add(element["ref"])
        filtered_mobile = "\n".join(line for line in mobile_text.splitlines() if line.split(" ", 1)[0] not in removed_refs)
        filtered_labels = {str(element[key]).strip() for element in mobile_elements if element["ref"] not in removed_refs
                           for key in ("text", "label", "name", "value") if element.get(key)}
        (directory / "mobile-no-status-bar.txt").write_text(filtered_mobile)
        payloads = {"raw_xml": source, "mobile_text": mobile_text, "mobile_no_status_bar": filtered_mobile, "mobile_json": (directory / "mobile.json.txt").read_text(), "clickable_only": click_text, "actions_context": context_text}
        live.append({
            "app": directory.name, "tokens": {name: len(encoder.encode(text, disallowed_special=())) for name, text in payloads.items()},
            "appium_visible_nodes": len(before_nodes), "mobile_nodes": len(mobile_elements),
            "mobile_status_bar_nodes_removed": len(removed_refs),
            "appium_before_after_same_labels": set(source_labels) == set(labels(after_nodes)),
            "appium_before_after_same_node_keys": before_keys == after_keys,
            "appium_label_count": len(source_labels),
            "mobile_exact_label_matches": len(set(source_labels) & mobile_labels),
            "filtered_mobile_exact_label_matches": len(set(source_labels) & filtered_labels),
            "mobile_missing_labels": sorted(set(source_labels) - mobile_labels),
        })
    summary = {}
    for app in sorted({row["app"] for row in rows} | {"all"}):
        samples = rows if app == "all" else [row for row in rows if row["app"] == app]
        summary[app] = {
            "screens": len(samples),
            "median_tokens": {name: statistics.median(row["tokens"][name] for row in samples) for name in samples[0]["tokens"]},
            "total_tokens": {name: sum(row["tokens"][name] for row in samples) for name in samples[0]["tokens"]},
            "clickable_retained_label_fraction": 1 - sum(len(row["clickable_missing_labels"]) for row in samples) / max(1, sum(row["label_count"] for row in samples)),
            "screens_losing_labels": sum(bool(row["clickable_missing_labels"]) for row in samples),
            "missed_inputs": sum(row["missed_inputs"] for row in samples),
            "missed_scrollers": sum(row["missed_scrollers"] for row in samples),
        }
    report = {"encoding": args.encoding, "tiktoken": tiktoken.__version__, "summary": summary, "live": live, "corpus": rows}
    (args.directory / "results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"summary": summary, "live": live}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
