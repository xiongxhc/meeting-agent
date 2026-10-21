import Foundation

/// Optional, separately measured identity and speaking-highlight channels.
///
/// Both default to absent, which keeps the bridge exactly where it was: every
/// roster row and speaker tile is unresolved, and `ui_snapshot` reports
/// `unknown / identity_unavailable`. Neither may be filled in from a guess.
/// Values come only from the real-client measurement (HUMAN-CHECKLIST 3.0b);
/// the bundled placeholders below exist so that a copied example is refused.
public struct MeasuredSpeakerSelectors: Sendable, Equatable {
    /// An accessibility attribute on a roster row or speaker tile that carries
    /// a per-person handle. One attribute serves both, so attendance and
    /// speaker ids share one namespace by construction.
    public struct Identity: Sendable, Equatable {
        /// `AXIdentifier` means the opaque suffix after the row/tile prefix.
        public let attribute: String
        /// Whole-value pattern a handle must match; anything else is unresolved.
        public let pattern: String
    }
    /// An accessibility attribute on a speaker tile whose value says "speaking".
    public struct Highlight: Sendable, Equatable {
        public let attribute: String
        public let speakingValue: String
    }
    public let identity: Identity?
    public let highlight: Highlight?

    public init(identity: Identity? = nil, highlight: Highlight? = nil) {
        self.identity = identity; self.highlight = highlight
    }
    public static let unmeasured = MeasuredSpeakerSelectors()

    /// Unmeasured example values. Refused by `decode`, used only by fixtures.
    public static let placeholder = MeasuredSpeakerSelectors(
        identity: Identity(attribute: "FeishuPlaceholderIdentity", pattern: "^feishu-placeholder-[0-9]+$"),
        highlight: Highlight(attribute: "FeishuPlaceholderSpeaking", speakingValue: "feishu-placeholder-speaking"))

    /// Identity may come only from identifier-type attributes: `AXIdentifier`
    /// (developer-assigned, never shown) and `AXDOMIdentifier` (the web `id` a
    /// Chromium/WebKit tree exposes). Every other attribute, `AXValue`, `AXHelp`,
    /// `AXValueDescription`, `AXTitleUIElement` included, can carry display text,
    /// and mapping names to user ids is forbidden (HUMAN-CHECKLIST 3). A new
    /// identifier-type attribute found by 3.0b needs a reviewed code change.
    static let identityAttributes: Set<String> = ["AXIdentifier", "AXDOMIdentifier"]
    /// Display text is never a speaking highlight either.
    static let nameAttributes: Set<String> = ["AXTitle", "AXDescription", "AXRoleDescription", "AXLabel", "AXPlaceholderValue"]
    /// Generic focus/selection is never a speaking highlight.
    static let focusAttributes: Set<String> = ["AXSelected", "AXFocused", "AXFocusedUIElement", "AXSelectedChildren", "AXSelectedRows", "AXSelectedCells", "AXMain", "AXFrontmost"]
    static let structuralAttributes: Set<String> = ["AXRole", "AXSubrole", "AXChildren", "AXParent", "AXEnabled", "AXWindow"]

    /// The private config `selectors.identity` / `selectors.highlight` objects.
    /// Throws for anything unmeasured, unknown, display-text or focus-derived.
    static func decode(identity: Any?, highlight: Any?) throws -> Self {
        func text(_ raw: [String: Any], _ key: String, max: Int) throws -> String {
            guard let value = raw[key] as? String, !value.isEmpty, value.utf8.count <= max, !value.contains("\0"),
                  value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { throw BridgeProcessError.invalidInput }
            return value
        }
        var resolvedIdentity: Identity?
        if let identity {
            guard let raw = identity as? [String: Any], Set(raw.keys) == ["attribute", "pattern"] else { throw BridgeProcessError.invalidInput }
            let value = Identity(attribute: try text(raw, "attribute", max: 128), pattern: try text(raw, "pattern", max: 256))
            guard identityAttributes.contains(value.attribute), value.pattern != placeholder.identity?.pattern,
                  let resolver = ConfiguredUiIdentity(value), !resolver.accepts("") else { throw BridgeProcessError.invalidInput }
            resolvedIdentity = value
        }
        var resolvedHighlight: Highlight?
        if let highlight {
            guard let raw = highlight as? [String: Any], Set(raw.keys) == ["attribute", "speakingValue"] else { throw BridgeProcessError.invalidInput }
            let value = Highlight(attribute: try text(raw, "attribute", max: 128), speakingValue: try text(raw, "speakingValue", max: 128))
            guard value.attribute != placeholder.highlight?.attribute, value.speakingValue != placeholder.highlight?.speakingValue,
                  !focusAttributes.contains(value.attribute), !nameAttributes.contains(value.attribute),
                  !structuralAttributes.contains(value.attribute), value.attribute != "AXIdentifier",
                  value.attribute != resolvedIdentity?.attribute else { throw BridgeProcessError.invalidInput }
            resolvedHighlight = value
        }
        return Self(identity: resolvedIdentity, highlight: resolvedHighlight)
    }

    /// Absent identity keeps today's behaviour: nothing is ever resolved.
    public func resolver() -> any UiIdentityResolver {
        guard let identity, let resolver = ConfiguredUiIdentity(identity) else { return UnknownUiIdentity() }
        return resolver
    }
}

/// Resolves a row/tile only from the measured identity attribute, validated
/// against the measured pattern. No lookup, no name, no order, no fallback.
public struct ConfiguredUiIdentity: UiIdentityResolver {
    private let attribute: String
    private let pattern: NSRegularExpression

    public init?(_ selector: MeasuredSpeakerSelectors.Identity) {
        guard Self.isLinear(selector.pattern), let compiled = try? NSRegularExpression(pattern: selector.pattern) else { return nil }
        attribute = selector.attribute; pattern = compiled
    }
    func accepts(_ value: String) -> Bool { Self.matches(pattern, value) }

    /// Only an `AXIdentifier` handle is recoverable from the element id alone.
    public func identify(uiElementId: String) -> String? {
        attribute == "AXIdentifier" ? validated(uiElementId, displayName: nil) : nil
    }

    public func identify(node: AccessibilityNode, uiElementId: String) -> String? {
        if attribute == "AXIdentifier" { return validated(uiElementId, displayName: node.title) }
        return node.measuredIdentity.text.flatMap { validated($0, displayName: node.title) }
    }

    private func validated(_ value: String, displayName: String?) -> String? {
        guard !value.isEmpty, value.utf8.count <= 1024, value != displayName,
              Self.matches(pattern, value) else { return nil }
        return value
    }

    /// A restricted grammar so one match is linear in the handle length:
    /// `^` atoms `$`, where an atom is an ASCII letter/digit, `_ - : @ =`, an
    /// escaped `\.` or `\-`, `\d`, or a `[...]` class of letters, digits,
    /// `_ : @ = .` and ranges. Each
    /// atom may take one quantifier; `{m}` is free, but at most one variable
    /// quantifier (`?`, `*`, `+`, `{m,n}`) is allowed in the whole pattern. No
    /// groups, alternation, wildcard, backreference or lookaround, so nothing
    /// can backtrack catastrophically on the control thread.
    static func isLinear(_ pattern: String) -> Bool {
        let s = Array(pattern.unicodeScalars)
        guard s.count >= 3, s.count <= 256, s.first == "^", s.last == "$" else { return false }
        let end = s.count - 1
        func plain(_ c: Unicode.Scalar) -> Bool {
            ("a"..."z").contains(c) || ("A"..."Z").contains(c) || ("0"..."9").contains(c) || "_:@=".unicodeScalars.contains(c)
        }
        func number(_ i: inout Int) -> Int? {
            var value = 0, digits = 0
            while i < end, ("0"..."9").contains(s[i]), digits < 4 { value = value * 10 + Int(s[i].value - 48); i += 1; digits += 1 }
            return digits == 0 || value > 1024 ? nil : value
        }
        var i = 1, variable = 0
        while i < end {
            if s[i] == "\\" {
                guard i + 1 < end, ".-d".unicodeScalars.contains(s[i + 1]) else { return false }
                i += 2
            } else if s[i] == "[" {
                i += 1
                let start = i
                while i < end, s[i] != "]" {
                    guard plain(s[i]) || s[i] == "-" || s[i] == "." else { return false }
                    i += 1
                }
                guard i < end, i > start, s[start] != "-" else { return false }
                i += 1
            } else if plain(s[i]) || s[i] == "-" {
                i += 1
            } else { return false }
            guard i < end else { break }
            switch s[i] {
            case "?", "*", "+": variable += 1; i += 1
            case "{":
                i += 1
                guard let low = number(&i), i < end else { return false }
                if s[i] == "," {
                    i += 1
                    guard let high = number(&i), high > low else { return false }
                    variable += 1
                }
                guard i < end, s[i] == "}" else { return false }
                i += 1
            default: break
            }
        }
        return variable <= 1
    }

    static func matches(_ pattern: NSRegularExpression, _ value: String) -> Bool {
        let range = NSRange(value.startIndex..., in: value)
        return pattern.firstMatch(in: value, options: [.anchored], range: range)?.range == range
    }
}
