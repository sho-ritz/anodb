//! App schema and the projection tables built from cells (same layout as the TypeScript
//! implementation: `space`, `id`, the columns, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`).

use std::collections::BTreeMap;

use anodb_protocol::TableRule;
use anodb_protocol::keys::is_lower_hex;
use anodb_protocol::payload::safe_integer;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use crate::EngineError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    Text,
    Integer,
    Real,
    Boolean,
    Json,
}

impl ColumnType {
    fn sql(self) -> &'static str {
        match self {
            Self::Text | Self::Json => "TEXT",
            Self::Integer | Self::Boolean => "INTEGER",
            Self::Real => "REAL",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Integer => "integer",
            Self::Real => "real",
            Self::Boolean => "boolean",
            Self::Json => "json",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableDef {
    pub columns: Vec<(String, ColumnType)>,
    pub rule: TableRule,
}

impl TableDef {
    pub fn new(columns: &[(&str, ColumnType)]) -> Self {
        Self {
            columns: columns.iter().map(|(n, t)| ((*n).into(), *t)).collect(),
            rule: TableRule::Plain,
        }
    }

    /// Only a row's creator may change it (owners / admins may also delete it).
    pub fn owned(mut self) -> Self {
        self.rule = TableRule::Owned;
        self
    }

    /// Only `authority` (the app's server identity) may write the table.
    pub fn confirmed(mut self, authority: &str) -> Self {
        self.rule = TableRule::Confirmed {
            authority: authority.into(),
        };
        self
    }

    pub fn column(&self, name: &str) -> Option<ColumnType> {
        self.columns
            .iter()
            .find(|(c, _)| c == name)
            .map(|(_, t)| *t)
    }
}

const RESERVED: [&str; 7] = [
    "id",
    "space",
    "createdAt",
    "updatedAt",
    "createdBy",
    "updatedBy",
    "isDeleted",
];

fn is_ident(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b[0].is_ascii_alphabetic()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Schema {
    pub tables: BTreeMap<String, TableDef>,
}

impl Schema {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a table (validated like `defineSchema`).
    pub fn table(mut self, name: &str, def: TableDef) -> Result<Self, EngineError> {
        let bad = |m: String| Err(EngineError::Invalid(m));
        if !is_ident(name) {
            return bad(format!("invalid table name \"{name}\""));
        }
        if name.to_lowercase().starts_with("anodb") {
            return bad(format!("table name \"{name}\" is reserved"));
        }
        for (c, _) in &def.columns {
            if !is_ident(c) {
                return bad(format!("invalid column name \"{name}.{c}\""));
            }
            if RESERVED.contains(&c.as_str()) {
                return bad(format!("column name \"{name}.{c}\" is reserved"));
            }
        }
        self.tables.insert(name.into(), def);
        Ok(self)
    }

    pub fn get(&self, table: &str) -> Option<&TableDef> {
        self.tables.get(table)
    }

    pub fn rule_of(&self, table: &str) -> Option<&TableRule> {
        self.tables.get(table).map(|d| &d.rule)
    }
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub(crate) fn create_table_sql(
    table: &str,
    def: &TableDef,
    default_space: &str,
    owner: &str,
) -> String {
    let mut cols = vec![
        format!(
            "space TEXT NOT NULL DEFAULT '{}'",
            default_space.replace('\'', "''")
        ),
        if is_lower_hex(owner, 64) {
            format!("id TEXT NOT NULL DEFAULT ('{owner}-' || lower(hex(randomblob(8))))")
        } else {
            "id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))".into()
        },
    ];
    cols.extend(
        def.columns
            .iter()
            .map(|(c, t)| format!("{} {}", quote_ident(c), t.sql())),
    );
    cols.extend([
        "\"createdAt\" INTEGER".into(),
        "\"updatedAt\" INTEGER NOT NULL DEFAULT 0".into(),
        "\"createdBy\" TEXT".into(),
        "\"updatedBy\" TEXT".into(),
        "PRIMARY KEY (space, id)".into(),
    ]);
    format!("CREATE TABLE {} ({})", quote_ident(table), cols.join(", "))
}

/// Rebuild the projection when this changes.
pub(crate) fn fingerprint(def: &TableDef) -> String {
    let rule = match &def.rule {
        TableRule::Plain => "open".to_owned(),
        TableRule::Owned => "owned".to_owned(),
        TableRule::Confirmed { authority } => format!("confirmed:{authority}"),
    };
    let mut cols: Vec<String> = def
        .columns
        .iter()
        .map(|(c, t)| format!("{c}:{}", t.name()))
        .collect();
    cols.sort();
    format!("rs1|{rule}|{}", cols.join(","))
}

/// `checkValue`: validate a value written by the app.
pub(crate) fn check_value(
    table: &str,
    column: &str,
    t: ColumnType,
    v: &Value,
) -> Result<(), EngineError> {
    let ok = match (t, v) {
        (_, Value::Null) => true,
        (ColumnType::Text, Value::String(_)) => true,
        (ColumnType::Integer, Value::Number(_)) => safe_integer(v).is_some(),
        (ColumnType::Real, Value::Number(n)) => n.as_f64().is_some_and(f64::is_finite),
        (ColumnType::Boolean, Value::Bool(_)) => true,
        (ColumnType::Json, _) => true,
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(EngineError::Invalid(format!(
            "{table}.{column} expects {}, got {v}",
            t.name()
        )))
    }
}

/// `toSql`: a merged wire value as stored in the projection (mismatched types become NULL).
pub(crate) fn to_sql(t: ColumnType, v: &Value) -> SqlValue {
    match (t, v) {
        (_, Value::Null) => SqlValue::Null,
        (ColumnType::Text, Value::String(s)) => SqlValue::Text(s.clone()),
        (ColumnType::Integer, _) => safe_integer(v).map_or(SqlValue::Null, SqlValue::Integer),
        (ColumnType::Real, Value::Number(n)) => n
            .as_f64()
            .filter(|f| f.is_finite())
            .map_or(SqlValue::Null, SqlValue::Real),
        (ColumnType::Boolean, Value::Bool(b)) => SqlValue::Integer(i64::from(*b)),
        (ColumnType::Json, _) => SqlValue::Text(v.to_string()),
        _ => SqlValue::Null,
    }
}
