import Foundation
import CoreFoundation

public let bridgeSessionSchemaV2 = "bridge-session/v2"

/// Independent source and bridge identities. Integers use canonical decimal JSON
/// strings, matching the accepted Runtime SDK without a lossy Number conversion.
public struct TimedMediaLease: Sendable {
    public let sessionId: UInt64
    public let bridgeSessionId: String
    public let connectEndpoint: String
    public let credential: String
    public let expiresAtMs: UInt64
    public let reconnectWindowMs: UInt64
    /// 2 or 3 only. Media v3 (drainable timed capture) is an explicit server
    /// declaration; there is no negotiation and no fallback between them.
    public let mediaProtocolVersion: UInt8
    public static let captureFormat = "pcm_s16le/24000/1/20ms"
    init(_ value: [String: Any], bridgeSessionId: String) throws {
        guard Set(value.keys) == ["sessionId", "bridgeSessionId", "connectEndpoint", "credential", "expiresAtMs", "reconnectWindowMs", "mediaProtocolVersion", "captureFormat", "timingContract"],
              let version = value["mediaProtocolVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
              version == 2 || version == 3,
              value["captureFormat"] as? String == Self.captureFormat,
              value["timingContract"] as? String == "capture-clock/v1",
              let bridge = value["bridgeSessionId"] as? String, bridge == bridgeSessionId,
              Self.identifier(bridge),
              let endpoint = value["connectEndpoint"] as? String, !endpoint.isEmpty, endpoint.utf8.count <= 2048,
              let token = value["credential"] as? String, !token.isEmpty, token.utf8.count <= 128,
              !token.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw BridgeProcessError.invalidInput }
        sessionId = try Self.integer(value["sessionId"])
        expiresAtMs = try Self.integer(value["expiresAtMs"])
        reconnectWindowMs = try Self.integer(value["reconnectWindowMs"])
        guard sessionId > 0, expiresAtMs > 0, reconnectWindowMs > 0 else { throw BridgeProcessError.invalidInput }
        mediaProtocolVersion = version == 3 ? 3 : 2
        self.bridgeSessionId = bridge; connectEndpoint = endpoint; credential = token
    }
    static func integer(_ value: Any?) throws -> UInt64 {
        guard let text = value as? String, let number = UInt64(text), String(number) == text else { throw BridgeProcessError.invalidInput }
        return number
    }
    static func identifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 64 && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }
}

/// `renew_media_lease`: the Runtime extended the SAME credential to a later
/// expiry. Only the Runtime source session and the new expiry cross the wire;
/// the credential, endpoint and window are fixed by `connect_media`.
public struct MediaLeaseRenewal: Equatable, Sendable {
    public let sessionId: UInt64
    public let expiresAtMs: UInt64
    init(sessionId: UInt64, expiresAtMs: UInt64) { self.sessionId = sessionId; self.expiresAtMs = expiresAtMs }
    init(_ value: [String: Any]) throws {
        guard Set(value.keys) == ["sessionId", "expiresAtMs"] else { throw BridgeProcessError.invalidInput }
        sessionId = try TimedMediaLease.integer(value["sessionId"])
        expiresAtMs = try TimedMediaLease.integer(value["expiresAtMs"])
        guard sessionId > 0, expiresAtMs > 0 else { throw BridgeProcessError.invalidInput }
    }
}

public struct BridgeCommandMessageV2: Sendable {
    public let sessionId: String, commandId: String
    public let legacy: BridgeCommandMessage?
    public let mediaLease: TimedMediaLease?
    public let leaseRenewal: MediaLeaseRenewal?
    let bytes: Data
    public static func decode(_ bytes: Data) throws -> Self {
        guard bytes.count <= 65_536, var object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              object["schema"] as? String == bridgeSessionSchemaV2,
              let session = object["sessionId"] as? String, !session.isEmpty,
              let command = object["commandId"] as? String, !command.isEmpty else { throw BridgeProcessError.invalidInput }
        if object["type"] as? String == "connect_media" {
            guard Set(object.keys) == ["schema", "sessionId", "commandId", "type", "mediaLease"],
                  let raw = object["mediaLease"] as? [String: Any] else { throw BridgeProcessError.invalidInput }
            return Self(sessionId: session, commandId: command, legacy: nil, mediaLease: try TimedMediaLease(raw, bridgeSessionId: session), leaseRenewal: nil, bytes: bytes)
        }
        if object["type"] as? String == "renew_media_lease" {
            guard Set(object.keys) == ["schema", "sessionId", "commandId", "type", "leaseRenewal"],
                  let raw = object["leaseRenewal"] as? [String: Any] else { throw BridgeProcessError.invalidInput }
            return Self(sessionId: session, commandId: command, legacy: nil, mediaLease: nil, leaseRenewal: try MediaLeaseRenewal(raw), bytes: bytes)
        }
        object["schema"] = bridgeSessionSchema
        let legacy = try JSONDecoder().decode(BridgeCommandMessage.self, from: JSONSerialization.data(withJSONObject: object))
        return Self(sessionId: session, commandId: command, legacy: legacy, mediaLease: nil, leaseRenewal: nil, bytes: bytes)
    }
}

public struct BoundedCommandLinesV2 {
    private var pending = Data()
    public init() {}
    public mutating func append(_ incoming: Data) throws -> [BridgeCommandMessageV2] {
        guard incoming.count <= 65_536 else { throw BridgeProcessError.inputTooLarge }
        var messages: [BridgeCommandMessageV2] = []
        for byte in incoming {
            if byte == 10 {
                guard !pending.isEmpty, String(data: pending, encoding: .utf8) != nil else { throw BridgeProcessError.invalidInput }
                messages.append(try BridgeCommandMessageV2.decode(pending))
                pending.removeAll(keepingCapacity: true)
            } else {
                guard pending.count < 65_536 else { throw BridgeProcessError.inputTooLarge }
                pending.append(byte)
            }
        }
        return messages
    }
    public func finish() throws { if !pending.isEmpty { throw BridgeProcessError.invalidInput } }
}

public struct ObservationTiming: Equatable, Sendable {
    public let clockDomainId: String
    public let hostBeforeNs: UInt64, hostAfterNs: UInt64
    public init(clockDomainId: String, hostBeforeNs: UInt64, hostAfterNs: UInt64) throws {
        guard TimedMediaLease.identifier(clockDomainId), hostAfterNs >= hostBeforeNs,
              hostAfterNs - hostBeforeNs <= 2_000_000_000 else { throw BridgeProcessError.invalidInput }
        self.clockDomainId = clockDomainId; self.hostBeforeNs = hostBeforeNs; self.hostAfterNs = hostAfterNs
    }
    var object: [String: Any] { ["clockDomainId": clockDomainId, "hostBeforeNs": String(hostBeforeNs), "hostAfterNs": String(hostAfterNs)] }
    init(object: [String: Any]) throws {
        guard Set(object.keys) == ["clockDomainId", "hostBeforeNs", "hostAfterNs"], let domain = object["clockDomainId"] as? String else { throw BridgeProcessError.invalidInput }
        try self.init(clockDomainId: domain, hostBeforeNs: TimedMediaLease.integer(object["hostBeforeNs"]), hostAfterNs: TimedMediaLease.integer(object["hostAfterNs"]))
    }
}

/// Validated v2 bytes. No arbitrary dictionary or audio payload crosses the
/// output/evidence boundary. UI-derived legacy-shaped events require timing or
/// an explicit absence; administrative events cannot carry observation timing.
public struct BridgeEventMessageV2: Sendable {
    public let sessionId: String, sequence: Int
    public let bytes: Data
    static let uiTypes: Set<String> = ["joined", "left", "participant_joined", "participant_left", "active_speaker"]
    public static func decode(_ data: Data) throws -> Self {
        guard data.count <= 4096, var object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["schema"] as? String == bridgeSessionSchemaV2,
              let session = object["sessionId"] as? String, !session.isEmpty,
              let type = object["type"] as? String else { throw BridgeProcessError.invalidInput }
        let sequence = try safeSequence(object["sequence"])
        if type == "ui_snapshot" {
            guard Set(object.keys) == ["schema", "sessionId", "sequence", "observedAt", "type", "snapshotSequence", "observationTiming", "state", "feishuUserId", "reason", "barrierBefore"],
                  let state = object["state"] as? String else { throw BridgeProcessError.invalidInput }
            _ = try safeSequence(object["snapshotSequence"])
            let reason = object["reason"] as? String, id = object["feishuUserId"] as? String
            let nullId = object["feishuUserId"] is NSNull, nullReason = object["reason"] is NSNull
            guard object["barrierBefore"] is NSNull || ["stream_start", "observation_drop", "poll_gap", "clock_reset"].contains(object["barrierBefore"] as? String ?? "") else { throw BridgeProcessError.invalidInput }
            if let raw = object["observationTiming"] as? [String: Any] {
                _ = try ObservationTiming(object: raw)
                guard reason != "timing_unavailable" else { throw BridgeProcessError.invalidInput }
            } else {
                guard object["observationTiming"] is NSNull, state == "unreadable", reason == "timing_unavailable" else { throw BridgeProcessError.invalidInput }
            }
            switch state {
            case "ui_exact": guard let id, !id.isEmpty, id.utf8.count <= 1024, nullReason else { throw BridgeProcessError.invalidInput }
            case "ambiguous": guard nullId, nullReason || reason == "identity_unavailable" else { throw BridgeProcessError.invalidInput }
            case "unknown": guard nullId, ["no_highlight", "identity_unavailable"].contains(reason ?? "") else { throw BridgeProcessError.invalidInput }
            case "unreadable": guard nullId, ["grid_unavailable", "snapshot_unreadable", "timing_unavailable"].contains(reason ?? "") else { throw BridgeProcessError.invalidInput }
            default: throw BridgeProcessError.invalidInput
            }
            object = ["schema": bridgeSessionSchema, "sessionId": session, "sequence": sequence, "observedAt": object["observedAt"] ?? NSNull(), "type": "media_disconnected", "reason": "validation"]
        } else {
            if uiTypes.contains(type) {
                guard object.keys.contains("observationTiming"), object.keys.contains("observationTimingReason") else { throw BridgeProcessError.invalidInput }
                if let raw = object["observationTiming"] as? [String: Any] {
                    _ = try ObservationTiming(object: raw)
                    guard object["observationTimingReason"] is NSNull else { throw BridgeProcessError.invalidInput }
                } else {
                    guard object["observationTiming"] is NSNull, object["observationTimingReason"] as? String == "timing_unavailable" else { throw BridgeProcessError.invalidInput }
                }
                object.removeValue(forKey: "observationTiming"); object.removeValue(forKey: "observationTimingReason")
            }
            object["schema"] = bridgeSessionSchema
        }
        _ = try JSONDecoder().decode(BridgeEventMessage.self, from: JSONSerialization.data(withJSONObject: object))
        return Self(sessionId: session, sequence: sequence, bytes: data)
    }
    static func safeSequence(_ value: Any?) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue >= 1,
              number.doubleValue <= 9_007_199_254_740_991, Double(number.intValue) == number.doubleValue else { throw BridgeProcessError.invalidInput }
        return number.intValue
    }
    static func legacy(_ message: BridgeEventMessage, timing: ObservationTiming?) throws -> Self {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as! [String: Any]
        object["schema"] = bridgeSessionSchemaV2
        if uiTypes.contains(object["type"] as! String) {
            object["observationTiming"] = timing?.object ?? NSNull()
            object["observationTimingReason"] = timing == nil ? "timing_unavailable" : NSNull()
        }
        return try decode(JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    }
    static func snapshot(_ value: UiSnapshotEvidence, sessionId: String, sequence: Int, observedAt: String) throws -> Self {
        var object = value.object
        object["schema"] = bridgeSessionSchemaV2; object["sessionId"] = sessionId
        object["sequence"] = sequence; object["observedAt"] = observedAt
        return try decode(JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    }
}
