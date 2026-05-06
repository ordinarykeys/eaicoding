use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

const JINGYI_RAW: &str = include_str!("../../src/services/agent/knowledge/jingyi-raw.json");

#[derive(Debug, Clone, Deserialize)]
struct RawParam {
    #[serde(default)]
    name: String,
    #[serde(default)]
    r#type: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RawItem {
    #[serde(default)]
    name: String,
    #[serde(default)]
    category: String,
    #[serde(default, rename = "className")]
    class_name: String,
    #[serde(default, rename = "returnType")]
    return_type: String,
    #[serde(default)]
    params: Vec<RawParam>,
    #[serde(default)]
    description: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RawKnowledge {
    #[serde(default)]
    module: String,
    #[serde(default)]
    categories: HashMap<String, Vec<RawItem>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JingyiParam {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct JingyiItem {
    pub name: String,
    pub category: String,
    pub class_name: String,
    pub return_type: String,
    pub signature: String,
    pub description: String,
    pub params: Vec<JingyiParam>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JingyiRoute {
    pub family: String,
    pub route_type: String,
    pub summary: String,
    pub evidence: Vec<String>,
    pub count: usize,
    pub primary_options: Vec<JingyiItem>,
    pub supporting_options: Vec<JingyiItem>,
    pub options: Vec<JingyiItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JingyiSearchHit {
    pub score: f64,
    pub item: JingyiItem,
}

#[derive(Debug, Clone, Serialize)]
pub struct JingyiSearchResult {
    pub module: String,
    pub query: String,
    pub expanded_terms: Vec<String>,
    pub evidence_terms: Vec<String>,
    pub count: usize,
    pub matches: Vec<JingyiItem>,
    pub related_implementations: Vec<JingyiRoute>,
    pub implementation_options: Vec<JingyiRoute>,
    pub lexical_search: serde_json::Value,
    pub semantic_search: serde_json::Value,
    pub reranker: serde_json::Value,
    pub note: String,
}

fn public_params(params: &[RawParam]) -> Vec<JingyiParam> {
    let mut out = Vec::new();
    for param in params {
        let name = param.name.trim();
        let param_type = param.r#type.trim();
        if name.is_empty() && param_type.is_empty() {
            continue;
        }
        if name.starts_with("局_")
            || name.starts_with("局")
            || matches!(name, "i" | "n" | "len")
            || name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            break;
        }
        out.push(JingyiParam {
            name: name.to_string(),
            param_type: param_type.to_string(),
        });
    }
    out
}

fn signature(item: &RawItem, params: &[JingyiParam]) -> String {
    let return_type = if item.return_type.trim().is_empty() {
        "无返回值"
    } else {
        item.return_type.trim()
    };
    let params_text = params
        .iter()
        .map(|param| {
            if param.param_type.is_empty() {
                param.name.clone()
            } else {
                format!("{}: {}", param.name, param.param_type)
            }
        })
        .collect::<Vec<_>>()
        .join("，");
    format!("{} {}（{}）", return_type, item.name.trim(), params_text)
}

fn flatten_items(raw: RawKnowledge) -> Vec<JingyiItem> {
    let mut items = Vec::new();
    for (category, raw_items) in raw.categories {
        for raw_item in raw_items {
            let name = raw_item.name.trim().to_string();
            if name.is_empty() {
                continue;
            }
            let params = public_params(&raw_item.params);
            items.push(JingyiItem {
                name,
                category: if raw_item.category.trim().is_empty() {
                    category.clone()
                } else {
                    raw_item.category.trim().to_string()
                },
                class_name: raw_item.class_name.trim().to_string(),
                return_type: if raw_item.return_type.trim().is_empty() {
                    "无返回值".to_string()
                } else {
                    raw_item.return_type.trim().to_string()
                },
                signature: signature(&raw_item, &params),
                description: raw_item.description.trim().to_string(),
                params,
            });
        }
    }
    items
}

fn load_items() -> Result<(String, Vec<JingyiItem>), String> {
    let raw: RawKnowledge = serde_json::from_str(JINGYI_RAW)
        .map_err(|err| format!("解析精易模块内置知识库失败：{err}"))?;
    let module = if raw.module.trim().is_empty() {
        "精易模块".to_string()
    } else {
        raw.module.clone()
    };
    Ok((module, flatten_items(raw)))
}

fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut ascii = String::new();
    let mut cjk = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            if !cjk.is_empty() {
                push_cjk_tokens(&cjk, &mut tokens);
                cjk.clear();
            }
            ascii.push(ch.to_ascii_lowercase());
        } else if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            if !ascii.is_empty() {
                tokens.push(ascii.clone());
                ascii.clear();
            }
            cjk.push(ch);
        } else {
            if !ascii.is_empty() {
                tokens.push(ascii.clone());
                ascii.clear();
            }
            if !cjk.is_empty() {
                push_cjk_tokens(&cjk, &mut tokens);
                cjk.clear();
            }
        }
    }
    if !ascii.is_empty() {
        tokens.push(ascii);
    }
    if !cjk.is_empty() {
        push_cjk_tokens(&cjk, &mut tokens);
    }
    dedupe(tokens)
}

fn push_cjk_tokens(text: &str, out: &mut Vec<String>) {
    let chars = text.chars().collect::<Vec<_>>();
    if chars.len() >= 2 {
        out.push(text.to_string());
    }
    for size in 2..=4 {
        if chars.len() < size {
            break;
        }
        for start in 0..=(chars.len() - size) {
            out.push(chars[start..start + size].iter().collect());
        }
    }
}

fn dedupe(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let clean = item.trim().to_string();
        if clean.len() < 2 || !seen.insert(clean.clone()) {
            continue;
        }
        out.push(clean);
    }
    out
}

fn param_name_tokens(item: &JingyiItem) -> Vec<String> {
    dedupe(
        item.params
            .iter()
            .flat_map(|param| tokenize(&param.name))
            .collect(),
    )
}

fn expand_query_terms(tokens: &[String], items: &[JingyiItem]) -> Vec<String> {
    let token_set = tokens.iter().cloned().collect::<HashSet<_>>();
    let mut votes: HashMap<String, f64> = HashMap::new();

    for item in items {
        let item_tokens = param_name_tokens(item);
        if item_tokens.is_empty() {
            continue;
        }
        let overlap = item_tokens
            .iter()
            .filter(|token| token_set.contains(token.as_str()))
            .count();
        if overlap < 2 {
            continue;
        }
        let weight = (overlap as f64).powf(1.4);
        for token in item_tokens {
            if !token_set.contains(token.as_str()) {
                *votes.entry(token).or_insert(0.0) += weight;
            }
        }
    }

    let mut ranked = votes
        .into_iter()
        .filter(|(_, score)| *score >= 1.0)
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| cmp_score(a.1, b.1).then_with(|| a.0.cmp(&b.0)));

    let mut expanded = tokens.to_vec();
    for (token, _) in ranked.into_iter().take(24) {
        if !expanded.contains(&token) {
            expanded.push(token);
        }
    }
    expanded
}

fn item_text(item: &JingyiItem) -> String {
    format!(
        "{} {} {} {} {} {} {} {}",
        item.name,
        item.category,
        item.class_name,
        item.return_type,
        item.signature,
        item.description,
        capability_alias_text(item),
        item.params
            .iter()
            .map(|param| format!("{} {}", param.name, param.param_type))
            .collect::<Vec<_>>()
            .join(" ")
    )
    .to_lowercase()
}

fn capability_alias_text(item: &JingyiItem) -> String {
    let name = item.name.to_lowercase();
    let class_name = item.class_name.to_lowercase();
    let params = item
        .params
        .iter()
        .map(|param| param.name.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    let mut aliases: Vec<&str> = Vec::new();

    let has_url_or_address = params.contains("网址") || params.contains("地址");
    let has_http_request_shape =
        params.contains("访问方式")
            || params.contains("提交信息")
            || params.contains("协议头")
            || params.contains("cookies")
            || name.contains("xmlhttp")
            || class_name.contains("xmlhttp");
    if has_url_or_address && has_http_request_shape {
        aliases.extend([
            "http",
            "https",
            "request",
            "response",
            "web",
            "get",
            "post",
            "json",
            "form",
            "网页",
            "网络",
            "请求",
            "访问",
            "提交",
            "协议头",
            "状态码",
            "cookie",
        ]);
    }
    if name.contains("xmlhttp") || class_name.contains("xmlhttp") {
        aliases.extend([
            "http",
            "request",
            "response",
            "post",
            "json",
            "form",
            "请求",
            "访问",
            "发送",
            "状态码",
        ]);
    }
    if name.contains("post数据") || class_name.contains("post数据") {
        aliases.extend([
            "http",
            "request",
            "post",
            "body",
            "payload",
            "form",
            "json",
            "multipart",
            "提交",
            "提交信息",
            "请求体",
            "参数",
            "协议头",
        ]);
    }
    if name.contains("json") || class_name.contains("json") {
        aliases.extend(["json", "解析", "数组", "对象", "字段", "成员"]);
    }
    if name.starts_with("线程_")
        || class_name.contains("线程")
        || params.contains("线程id")
        || params.contains("子程序指针")
        || params.contains("要启动的子程序")
        || params.contains("欲执行的子程序")
    {
        aliases.extend([
            "thread",
            "threads",
            "multithread",
            "concurrent",
            "多线程",
            "线程",
            "并发",
            "启动线程",
            "后台执行",
        ]);
    }

    dedupe(aliases.into_iter().map(str::to_string).collect()).join(" ")
}

fn item_field_texts(item: &JingyiItem) -> Vec<(&'static str, String)> {
    vec![
        ("name", item.name.to_lowercase()),
        ("class", item.class_name.to_lowercase()),
        ("category", item.category.to_lowercase()),
        ("return", item.return_type.to_lowercase()),
        ("signature", item.signature.to_lowercase()),
        ("description", item.description.to_lowercase()),
        ("capability", capability_alias_text(item).to_lowercase()),
        (
            "params",
            item.params
                .iter()
                .map(|param| format!("{} {}", param.name, param.param_type))
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase(),
        ),
    ]
}

fn token_match_score(token: &str, field: &str, weight: f64) -> f64 {
    if token.is_empty() || field.is_empty() {
        return 0.0;
    }
    if field == token {
        return weight * 5.0;
    }
    if field.starts_with(token) {
        return weight * 3.2;
    }
    if field.contains(token) {
        return weight * 1.6;
    }
    0.0
}

fn namespace(item: &JingyiItem) -> Option<String> {
    item.name
        .split_once('_')
        .map(|(left, _)| left.trim().to_string())
        .filter(|left| left.chars().count() >= 2)
}

fn item_key(item: &JingyiItem) -> String {
    format!(
        "{}:{}:{}:{}",
        item.category, item.class_name, item.name, item.signature
    )
}

fn score_item(item: &JingyiItem, query: &str, tokens: &[String]) -> f64 {
    let q = query.trim().to_lowercase();
    let fields = item_field_texts(item);
    let full_text = item_text(item);
    let mut score = 0.0;

    if item.name.to_lowercase() == q {
        score += 160.0;
    } else if item.name.to_lowercase().starts_with(&q) {
        score += 90.0;
    } else if item.name.to_lowercase().contains(&q) {
        score += 55.0;
    }
    if !item.class_name.is_empty() && item.class_name.to_lowercase() == q {
        score += 110.0;
    } else if !item.class_name.is_empty() && item.class_name.to_lowercase().contains(&q) {
        score += 35.0;
    }

    for token in tokens {
        for (field_name, field_text) in &fields {
            let weight = match *field_name {
                "name" => 18.0,
                "class" => 12.0,
                "signature" => 10.0,
                "params" => 11.0,
                "capability" => 14.0,
                "description" => 5.5,
                "return" => 4.5,
                _ => 3.0,
            };
            score += token_match_score(token, field_text, weight);
        }
    }

    let matched_tokens = tokens.iter().filter(|token| full_text.contains(token.as_str())).count();
    if matched_tokens > 1 {
        score += (matched_tokens as f64).powf(1.35) * 12.0;
    }

    let matched_param_tokens = tokens
        .iter()
        .filter(|token| {
            item.params
                .iter()
                .any(|param| param.name.to_lowercase().contains(token.as_str()))
        })
        .count();
    if matched_param_tokens > 1 {
        score += (matched_param_tokens as f64).powf(1.45) * 24.0;
    }

    if item.category == "子程序" {
        score += 10.0;
    }
    if item.category == "全局变量" || item.category == "常量" {
        score -= 8.0;
    }
    score += item_structural_role_bonus(item);
    score
}

fn cmp_score(left: f64, right: f64) -> Ordering {
    right.partial_cmp(&left).unwrap_or(Ordering::Equal)
}

fn route_type(family: &str, items: &[JingyiItem]) -> String {
    if family.starts_with("类_") || items.iter().any(|item| item.class_name == family) {
        "object_workflow".to_string()
    } else {
        "function_family".to_string()
    }
}

fn family_for(item: &JingyiItem) -> Option<String> {
    if !item.class_name.is_empty() {
        return Some(item.class_name.clone());
    }
    let name = item.name.trim();
    if name.starts_with("网页_访问") {
        return Some("网页_访问".to_string());
    }
    if name.starts_with("线程_") {
        return Some("线程_*".to_string());
    }
    if name.contains('_') {
        let parts = name.split('_').collect::<Vec<_>>();
        if parts.len() >= 2 {
            return Some(format!("{}_{}", parts[0], parts[1]));
        }
    }
    namespace(item)
}

fn route_capability_key(route: &JingyiRoute) -> String {
    let evidence = route
        .options
        .iter()
        .map(capability_alias_text)
        .collect::<Vec<_>>()
        .join(" ");
    let family = route.family.to_lowercase();
    if evidence.contains("thread") || family.contains("线程") {
        return "thread".to_string();
    }
    if evidence.contains("request")
        || evidence.contains("http")
        || evidence.contains("请求")
        || family.contains("网页")
        || family.contains("xmlhttp")
    {
        return "http".to_string();
    }
    if evidence.contains("json") || family.contains("json") {
        return "json".to_string();
    }
    if family.contains("找图") || family.contains("识图") || family.contains("图片") {
        return "image".to_string();
    }
    family
        .split('_')
        .next()
        .unwrap_or(route.family.as_str())
        .to_string()
}

fn is_main_http_item(item: &JingyiItem) -> bool {
    let text = item_text(item);
    let params = item
        .params
        .iter()
        .map(|param| param.name.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    let has_url_or_address = params.contains("网址") || params.contains("地址");
    let has_request_shape =
        params.contains("访问方式")
            || params.contains("提交信息")
            || params.contains("协议头")
            || params.contains("cookies")
            || text.contains("xmlhttp")
            || text.contains("发送请求");
    has_url_or_address && has_request_shape
}

fn is_helper_builder_item(item: &JingyiItem) -> bool {
    let name = item.name.to_lowercase();
    let class_name = item.class_name.to_lowercase();
    name.contains("post数据")
        || class_name.contains("post数据")
        || name.contains("获取post数据")
        || name.contains("获取协议头数据")
}

fn is_main_thread_item(item: &JingyiItem) -> bool {
    let name = item.name.to_lowercase();
    let params = item
        .params
        .iter()
        .map(|param| param.name.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    let has_target_proc =
        params.contains("要启动的子程序")
            || params.contains("欲执行的子程序")
            || params.contains("子程序指针");
    let has_thread_output = params.contains("线程id") || params.contains("线程句柄");
    name.contains("启动") && has_target_proc && has_thread_output
}

fn item_structural_role_bonus(item: &JingyiItem) -> f64 {
    if is_main_http_item(item) {
        return 70.0;
    }
    if is_main_thread_item(item) {
        return 85.0;
    }
    if is_helper_builder_item(item) {
        return -20.0;
    }
    0.0
}

fn route_role_bonus(route: &JingyiRoute) -> f64 {
    if route.options.iter().any(is_main_http_item) {
        return 140.0;
    }
    if route.options.iter().any(is_main_thread_item) {
        return 90.0;
    }
    if route.options.iter().any(is_helper_builder_item) {
        return -60.0;
    }
    0.0
}

fn diversify_routes(scored_routes: Vec<(f64, JingyiRoute)>, limit: usize) -> Vec<JingyiRoute> {
    let mut adjusted = scored_routes
        .into_iter()
        .map(|(score, route)| (score + route_role_bonus(&route), route))
        .collect::<Vec<_>>();
    adjusted.sort_by(|a, b| cmp_score(a.0, b.0));

    let top_score = adjusted.first().map(|(score, _)| *score).unwrap_or(0.0);
    let diversity_floor = top_score * 0.45;
    let mut selected: Vec<(f64, JingyiRoute)> = Vec::new();
    let mut used_keys = HashSet::new();
    let mut rest = Vec::new();

    for (score, route) in adjusted {
        let key = route_capability_key(&route);
        if score >= diversity_floor && used_keys.insert(key) {
            selected.push((score, route));
            if selected.len() >= limit {
                break;
            }
        } else {
            rest.push((score, route));
        }
    }

    if selected.len() < limit {
        selected.extend(rest.into_iter().take(limit - selected.len()));
    }

    selected.into_iter().map(|(_, route)| route).collect()
}

fn build_routes(items: &[JingyiItem], query: &str, tokens: &[String], limit: usize) -> Vec<JingyiRoute> {
    let mut by_family: HashMap<String, Vec<JingyiItem>> = HashMap::new();
    for item in items {
        if let Some(family) = family_for(item) {
            by_family.entry(family).or_default().push(item.clone());
        }
    }

    let mut routes = Vec::new();
    for (family, mut family_items) in by_family {
        family_items.sort_by(|a, b| cmp_score(score_item(a, query, tokens), score_item(b, query, tokens)));
        let score = family_items
            .iter()
            .take(5)
            .map(|item| score_item(item, query, tokens))
            .sum::<f64>()
            / family_items.len().min(5) as f64;
        if score <= 0.0 {
            continue;
        }
        let kind = route_type(&family, &family_items);
        let primary = family_items.iter().take(if kind == "object_workflow" { 4 } else { 3 }).cloned().collect::<Vec<_>>();
        let supporting = family_items.iter().skip(primary.len()).take(8).cloned().collect::<Vec<_>>();
        routes.push((score, JingyiRoute {
            family: family.clone(),
            route_type: kind.clone(),
            summary: if kind == "object_workflow" {
                format!("对象/类调用链：{family}")
            } else {
                format!("同族函数方案：{family}")
            },
            evidence: vec![
                format!("route_type={kind}"),
                format!("primary={}", primary.iter().map(|item| item.name.as_str()).collect::<Vec<_>>().join(" / ")),
            ],
            count: family_items.len(),
            primary_options: primary,
            supporting_options: supporting,
            options: family_items.into_iter().take(20).collect(),
        }));
    }
    routes.sort_by(|a, b| cmp_score(a.0, b.0));
    diversify_routes(routes, limit)
}

#[tauri::command]
pub async fn search_jingyi_module_rust(
    query: String,
    limit: Option<usize>,
) -> Result<JingyiSearchResult, String> {
    let safe_limit = limit.unwrap_or(8).clamp(1, 20);
    let (module, items) = load_items()?;
    let query_tokens = tokenize(&query);
    let tokens = expand_query_terms(&query_tokens, &items);
    let mut scored = items
        .iter()
        .cloned()
        .map(|item| {
            let score = score_item(&item, &query, &tokens);
            (score, item)
        })
        .filter(|(score, _)| *score > 0.0)
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| cmp_score(a.0, b.0).then_with(|| a.1.name.cmp(&b.1.name)));

    let mut seen = HashSet::new();
    let mut matches = Vec::new();
    let mut lexical_hits = Vec::new();
    for (score, item) in scored {
        if !seen.insert(item_key(&item)) {
            continue;
        }
        if lexical_hits.len() < safe_limit {
            lexical_hits.push(JingyiSearchHit {
                score: (score * 100.0).round() / 100.0,
                item: item.clone(),
            });
        }
        matches.push(item);
        if matches.len() >= safe_limit * 10 {
            break;
        }
    }

    let routes = build_routes(&matches, &query, &tokens, 8);
    let final_matches = matches.into_iter().take(safe_limit).collect::<Vec<_>>();

    Ok(JingyiSearchResult {
        module,
        query,
        expanded_terms: tokens.clone(),
        evidence_terms: tokens,
        count: final_matches.len(),
        matches: final_matches,
        related_implementations: routes.clone(),
        implementation_options: routes,
        lexical_search: serde_json::json!({
            "enabled": true,
            "indexed_count": items.len(),
            "method": "Rust BM25-lite + structured fields + API-family reranker",
            "matches": lexical_hits,
        }),
        semantic_search: serde_json::json!({
            "enabled": false,
            "model": "rust-local-reranker",
            "indexed_count": items.len(),
            "error": "向量召回仍由前端 fallback 提供；Rust 侧先承载低延迟检索与 reranker。"
        }),
        reranker: serde_json::json!({
            "enabled": true,
            "method": "structured score + namespace/class/function-family grouping",
        }),
        note: "Rust 知识检索已启用：先做结构化召回和 reranker，下游仍按 implementation_options 比较多种实现；如 Rust 检索失败，前端会回退到 TS 检索。".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(query: &str) -> JingyiSearchResult {
        tauri::async_runtime::block_on(search_jingyi_module_rust(query.to_string(), Some(12)))
            .expect("rust jingyi search should work")
    }

    fn route_names(result: &JingyiSearchResult) -> Vec<String> {
        result
            .implementation_options
            .iter()
            .map(|route| route.family.clone())
            .collect()
    }

    fn option_names(result: &JingyiSearchResult) -> Vec<String> {
        result
            .implementation_options
            .iter()
            .flat_map(|route| route.primary_options.iter())
            .map(|item| {
                if item.class_name.is_empty() {
                    item.name.clone()
                } else {
                    format!("{}.{}", item.class_name, item.name)
                }
            })
            .collect()
    }

    fn contains_all(items: &[String], needles: &[&str]) -> bool {
        needles
            .iter()
            .all(|needle| items.iter().any(|item| item.contains(needle)))
    }

    #[test]
    fn post_query_groups_multiple_http_implementations() {
        let search = result("帮我写一个POST请求案例");
        assert!(
            contains_all(&route_names(&search), &["网页_访问"]),
            "routes={:?}",
            route_names(&search)
        );
        assert!(
            contains_all(&option_names(&search), &["网页_访问_对象", "网页_访问S"]),
            "options={:?}",
            option_names(&search)
        );
    }

    #[test]
    fn thread_post_query_keeps_thread_and_http_evidence() {
        let search = result("写个多线程POST案例");
        assert!(
            contains_all(&route_names(&search), &["线程", "网页_访问"]),
            "routes={:?}",
            route_names(&search)
        );
        assert!(
            contains_all(&option_names(&search), &["线程_启动", "网页_访问_对象"]),
            "options={:?}",
            option_names(&search)
        );
    }
}
