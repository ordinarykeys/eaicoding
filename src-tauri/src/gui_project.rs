//! Native e2txt window projects. Geometry lives in .form.json; properties and
//! event handlers are emitted as Easy Language source so they remain editable.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::Path};

#[derive(Debug, Deserialize, Serialize)]
pub struct GuiProject {
    pub windows: Vec<GuiWindow>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GuiWindow {
    pub name: String,
    pub title: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub declarations: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub events: Vec<GuiEvent>,
    #[serde(default)]
    pub controls: Vec<GuiControl>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GuiControl {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub events: Vec<GuiEvent>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GuiEvent {
    pub name: String,
    pub code: String,
}

fn identifier(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 64
        && name
            .chars()
            .enumerate()
            .all(|(i, c)| c == '_' || c.is_alphabetic() || (i > 0 && c.is_ascii_digit()))
}

fn validate_events(events: &[GuiEvent], supported: &[&str]) -> Result<(), String> {
    let mut names = HashSet::new();
    for event in events {
        if !supported.contains(&event.name.as_str()) || !names.insert(&event.name) {
            return Err(format!(
                "事件不支持或重复：{}；可用事件：{}",
                event.name,
                supported.join("、")
            ));
        }
        if event
            .code
            .lines()
            .any(|line| line.trim_start().starts_with(".子程序"))
        {
            return Err("events.code 只能包含事件体；其他子程序请放在窗口 code 字段".into());
        }
    }
    Ok(())
}

impl GuiProject {
    pub fn validate(&self) -> Result<(), String> {
        if self.windows.is_empty() || self.windows.len() > 8 || self.windows[0].name != "_启动窗口"
        {
            return Err("需要 1–8 个窗口，第一个窗口必须命名为 _启动窗口".into());
        }
        let mut names = HashSet::new();
        // Window and control names share the native project's identifier space.
        for window in &self.windows {
            if !identifier(&window.name) || !names.insert(window.name.clone()) {
                return Err(format!("窗口名无效或重复：{}", window.name));
            }
        }
        for window in &self.windows {
            if !(160..=4096).contains(&window.width)
                || !(100..=4096).contains(&window.height)
                || window.controls.len() > 200
            {
                return Err(format!(
                    "窗口 {} 尺寸超出范围或控件超过 200 个",
                    window.name
                ));
            }
            validate_events(&window.events, &["创建完毕", "将被销毁"])?;
            if window
                .declarations
                .lines()
                .any(|l| l.trim_start().starts_with(".子程序"))
            {
                return Err("declarations 只能放程序集变量声明，子程序请放在 code 字段".into());
            }
            for control in &window.controls {
                if !identifier(&control.name) || !names.insert(control.name.clone()) {
                    return Err(format!("控件名无效或重复：{}", control.name));
                }
                if control.width == 0
                    || control.height == 0
                    || control.left.saturating_add(control.width) > window.width
                    || control.top.saturating_add(control.height) > window.height
                {
                    return Err(format!("控件 {} 超出窗口范围或尺寸为零", control.name));
                }
                let supported: &[&str] = match control.kind.as_str() {
                    "按钮" | "选择框" | "单选框" => &["被单击"],
                    "编辑框" => &["内容被改变"],
                    "标签" => &["被单击"],
                    _ => {
                        return Err(format!(
                            "暂不支持控件类型：{}；支持按钮、编辑框、标签、选择框、单选框",
                            control.kind
                        ))
                    }
                };
                validate_events(&control.events, supported)?;
            }
        }
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 2_000_000 {
            return Err("窗口工程描述超过 2MB".into());
        }
        Ok(())
    }
}

fn native_control(name: &str, kind: &str, left: u32, top: u32, width: u32, height: u32) -> Value {
    json!({"Children":[],"Comment":"","Cursor":"00000000","DataType":kind,
        "Disable":false,"ExtensionData":"","Height":height,"Left":left,"Name":name,
        "Tag":"","Top":top,"UnknownBeforeEvents":0,
        "UnknownBeforeExtensionData":"0000000000000000000000000000000000000000",
        "UnknownBeforeLeft":0,"UnknownBeforeName":"0000000000000000000000000000000000000000",
        "UnknownBeforeParent":0,"UnknownBeforeVisible":0,"Visible":true,"Width":width})
}

// Byte literals preserve the native GBK text encoding and cannot inject code.
fn text_expression(text: &str) -> Result<String, String> {
    if text.is_empty() {
        return Ok("“”".into());
    }
    let (bytes, _, invalid) = encoding_rs::GBK.encode(text);
    if invalid {
        return Err("控件文本含易语言 GBK 不支持的字符".into());
    }
    Ok(format!(
        "到文本 ({{{}}})",
        bytes
            .iter()
            .map(|b| b.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn event_source(owner: &str, event: &GuiEvent) -> String {
    format!(
        "\r\n.子程序 _{}_{}\r\n{}\r\n",
        owner,
        event.name,
        event.code.replace("\r\n", "\n").replace('\n', "\r\n")
    )
}

/// The caller supplies an isolated copy of the bundled console template.
pub fn write_gui_project(root: &Path, project: &GuiProject) -> Result<String, String> {
    project.validate()?;
    let write = |path: &Path, text: &str| {
        fs::write(path, text).map_err(|e| format!("写入 {} 失败：{}", path.display(), e))
    };
    fs::create_dir_all(root.join("窗口")).map_err(|e| e.to_string())?;
    write(&root.join("配置/系统.config.json"), &serde_json::to_string_pretty(&json!({
        "Lang":1,"ProjectType":0,"ProjectVersion":{"Major":1,"Minor":7},"Type":1,"Version":{"Major":5,"Minor":6}
    })).unwrap())?;
    // Console entry points must not survive the switch to a GUI project.
    let console = root.join("代码/程序集1.static.e.txt");
    if console.exists() {
        fs::remove_file(console).map_err(|e| e.to_string())?;
    }
    let mut order = String::new();
    for (index, window) in project.windows.iter().enumerate() {
        let assembly = format!("窗口程序集_{}", window.name);
        order.push_str(&format!("{}\r\n", assembly));
        let mut controls = vec![native_control(
            "",
            "窗口",
            100,
            100,
            window.width,
            window.height,
        )];
        controls.extend(
            window
                .controls
                .iter()
                .map(|c| native_control(&c.name, &c.kind, c.left, c.top, c.width, c.height)),
        );
        let form = json!({"Class":assembly,"Comment":"","Controls":controls,
            "Id":1375797249u32 + index as u32,"Menus":[],"Name":window.name,"UnknownAfterId":0,"UnknownBeforeClass":0});
        write(
            &root.join(format!("窗口/{}.form.json", window.name)),
            &serde_json::to_string_pretty(&form).unwrap(),
        )?;
        let mut code = format!(
            ".版本 2\r\n.程序集 {}\r\n{}\r\n\r\n.子程序 _{}_创建完毕\r\n{}.标题 ＝ {}\r\n",
            assembly,
            window.declarations,
            window.name,
            window.name,
            text_expression(&window.title)?
        );
        for control in &window.controls {
            let property = if control.kind == "编辑框" {
                "内容"
            } else {
                "标题"
            };
            code.push_str(&format!(
                "{}.{} ＝ {}\r\n",
                control.name,
                property,
                text_expression(&control.text)?
            ));
        }
        if let Some(event) = window.events.iter().find(|e| e.name == "创建完毕") {
            code.push_str(&event.code);
            code.push_str("\r\n");
        }
        for event in window.events.iter().filter(|e| e.name != "创建完毕") {
            code.push_str(&event_source(&window.name, event));
        }
        for control in &window.controls {
            for event in &control.events {
                code.push_str(&event_source(&control.name, event));
            }
        }
        code.push_str("\r\n");
        code.push_str(&window.code);
        write(&root.join(format!("代码/{}.form.e.txt", assembly)), &code)?;
    }
    write(&root.join("代码/排序.list.txt"), &order)?;
    let layout = root.join("gui-layout.json");
    write(
        &layout,
        &serde_json::to_string_pretty(project).map_err(|e| e.to_string())?,
    )?;
    Ok(layout.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn demo() -> GuiProject {
        serde_json::from_value(json!({"windows":[{"name":"_启动窗口","title":"EAiCoding GUI Probe","width":500,"height":320,
            "controls":[{"name":"按钮1","type":"按钮","left":30,"top":100,"width":120,"height":32,"text":"Click",
                "events":[{"name":"被单击","code":"编辑框1.内容 ＝ “Clicked”"}]},
                {"name":"编辑框1","type":"编辑框","left":30,"top":40,"width":280,"height":28,"text":"Ready"}]}]})).unwrap()
    }
    #[test]
    fn rejects_invalid_layouts() {
        let mut project = demo();
        project.windows[0].controls[0].name = "../escape".into();
        assert!(project.validate().is_err());
        project.windows[0].controls[0].name = "编辑框1".into();
        assert!(project.validate().is_err());
        project.windows[0].controls[0].name = "按钮1".into();
        project.windows[0].controls[0].left = 500;
        assert!(project.validate().is_err());
    }
    #[test]
    fn emits_native_layout_and_bound_event_source() {
        let root = std::env::temp_dir().join(format!("eaicoding-gui-{}", std::process::id()));
        fs::create_dir_all(root.join("代码")).unwrap();
        fs::create_dir_all(root.join("配置")).unwrap();
        write_gui_project(&root, &demo()).unwrap();
        let code = fs::read_to_string(root.join("代码/窗口程序集__启动窗口.form.e.txt")).unwrap();
        assert!(code.contains(".子程序 __启动窗口_创建完毕"));
        assert!(code.contains(".子程序 _按钮1_被单击"));
        assert!(code.contains("编辑框1.内容 ＝ “Clicked”"));
        let form: Value =
            serde_json::from_slice(&fs::read(root.join("窗口/_启动窗口.form.json")).unwrap())
                .unwrap();
        assert_eq!(form["Controls"][1]["Left"], 30);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "native toolchain smoke fixture; run through scripts/test-native-gui.ps1"]
    fn native_gui_fixture() {
        let root = std::path::PathBuf::from(
            std::env::var("EAICODING_GUI_SMOKE_DIR").expect("smoke directory required"),
        );
        assert!(!root.exists(), "smoke output must be a new directory");
        crate::ecode_parser::copy_dir_all(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources/eagent-tools/templates/console.ecode"),
            &root,
        )
        .unwrap();
        let mut project = demo();
        project.windows[0].title = "EAiCoding 窗口测试".into();
        project.windows[0].controls.extend(serde_json::from_value::<Vec<GuiControl>>(json!([
            {"name":"标签1","type":"标签","left":30,"top":10,"width":280,"height":24,"text":"Label"},
            {"name":"选择框1","type":"选择框","left":30,"top":160,"width":150,"height":28,"text":"Checkbox"},
            {"name":"单选框1","type":"单选框","left":200,"top":160,"width":150,"height":28,"text":"Radio"}
        ])).unwrap());
        write_gui_project(&root, &project).unwrap();
    }
}
