//! Row-level write rule (PROTOCOL.md §4.1), evaluated identically by every device when it applies a
//! change, so the shared state cannot contain a refused change.

use crate::keys::is_lower_hex;
use crate::payload::Change;

pub const SYS_DELETED: &str = "$deleted";
pub const SYS_CREATED: &str = "$createdAt";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Role {
    Reader,
    Writer,
    Admin,
    Owner,
}

impl Role {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "owner" => Self::Owner,
            "admin" => Self::Admin,
            "writer" => Self::Writer,
            "reader" => Self::Reader,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Writer => "writer",
            Self::Reader => "reader",
        }
    }

    pub fn can_write(r: Option<Self>) -> bool {
        r.is_some_and(|r| r >= Self::Writer)
    }

    pub fn is_admin(r: Option<Self>) -> bool {
        r.is_some_and(|r| r >= Self::Admin)
    }
}

/// How a table restricts writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TableRule {
    /// Any writer may change or delete any row (default).
    Plain,
    /// Only the row's creator may change it; owners/admins may also delete it.
    Owned,
    /// Only this identity (the app's server) may write the table.
    Confirmed { authority: String },
}

/// The creator named by a row id: `<64 hex>` or `<64 hex>-<1–63 of [A-Za-z0-9_]>`.
pub fn owner_of_row(row_id: &str) -> Option<&str> {
    let (pk, rest) = row_id.split_at_checked(64)?;
    if !is_lower_hex(pk, 64) {
        return None;
    }
    match rest.strip_prefix('-') {
        None if rest.is_empty() => Some(pk),
        Some(s)
            if (1..=63).contains(&s.len())
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') =>
        {
            Some(pk)
        }
        _ => None,
    }
}

/// `rule` is the table's rule, or `None` for a table this implementation does not know.
///
/// Tables the schema does not know are treated as plain (PROTOCOL.md §4.1).
pub fn change_allowed(
    rule: Option<&TableRule>,
    c: &Change,
    writer: &str,
    role: Option<Role>,
) -> bool {
    if let Some(TableRule::Confirmed { authority }) = rule {
        return writer == authority;
    }
    let owner = owner_of_row(&c.row_id);
    if owner.is_none() || owner == Some(writer) {
        return true;
    }
    if c.column == SYS_CREATED {
        return false;
    }
    if rule != Some(&TableRule::Owned) {
        return true;
    }
    if c.column == SYS_DELETED {
        return matches!(role, Some(Role::Owner | Role::Admin));
    }
    false
}
