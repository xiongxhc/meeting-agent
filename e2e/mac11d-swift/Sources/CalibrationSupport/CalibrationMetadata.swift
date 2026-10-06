import Foundation
import FeishuBridgeSpike

public enum CalibrationBarrier: String, Encodable, Sendable {
    case childReady = "child_ready", captureStarted = "capture_started", outputStarted = "output_started"
    case captureEmissionComplete = "capture_emission_complete", captureStopped = "capture_stopped"
    case outputStopped = "output_stopped", controlFinished = "control_finished"
    case transportWriteFault = "transport_write_fault"
    case metadataClockFault = "metadata_clock_fault"
    case nativePrimaryFault = "native_primary_fault", nativeStopCompletionLate = "native_stop_completion_late"
    case wallRollback = "wall_rollback", expiryTransportFault = "expiry_transport_fault"
}
public struct CalibrationCounts: Encodable, Sendable {
    public var captureStarts = 0, captureStops = 0, outputStarts = 0, outputStops = 0
    public var emittedBuffers = 0, emittedSamples = 0
    public init() {}
}
public final class CalibrationState: @unchecked Sendable {
    private let lock = NSLock()
    private var counts = CalibrationCounts()
    public init() {}
    public var snapshot: CalibrationCounts { lock.withLock { counts } }
    public func captureStarted() { lock.withLock { counts.captureStarts += 1 } }
    public func captureStopped() { lock.withLock { counts.captureStops += 1 } }
    public func outputStarted() { lock.withLock { counts.outputStarts += 1 } }
    public func outputStopped() { lock.withLock { counts.outputStops += 1 } }
    public func emitted(frames: Int) { lock.withLock { counts.emittedBuffers += 1; counts.emittedSamples += frames } }
}
public enum CalibrationMetadata {
    public static func result(counts: CalibrationCounts, stop: TimedMediaStopResult?, departure: BridgeCleanupStatus?,
                              scenario: CalibrationScenario = .normal, faults: FaultConnectionSnapshot? = nil,
                              metadataFault: MetadataFaultSnapshot? = nil, nativeFault: NativeFaultSnapshot? = nil,
                              nativeConnections: Int? = nil, expiryFault: ExpiryFaultConnectionSnapshot? = nil,
                              rollbackApplied: Bool? = nil) throws -> Data {
        guard ([.confirmedCleanupWrite, .unconfirmedCleanupWrite].contains(scenario)) == (faults != nil),
              (scenario == .metadataPrimary) == (metadataFault != nil),
              ([.nativePrimary, .unconfirmedCleanupWrite].contains(scenario)) == (nativeFault != nil),
              (scenario == .nativePrimary) == (nativeConnections != nil),
              (scenario == .expiryRollback) == (expiryFault != nil),
              (scenario == .expiryRollback) == (rollbackApplied != nil) else { throw BridgeProcessError.invalidInput }
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(counts)) as! [String: Any]
        if let faults {
            let counters = try JSONSerialization.jsonObject(with: JSONEncoder().encode(faults)) as! [String: Any]
            object.merge(counters) { _, new in new }
        }
        if let metadataFault {
            let counters = try JSONSerialization.jsonObject(with: JSONEncoder().encode(metadataFault)) as! [String: Any]
            object.merge(counters) { _, new in new }
        }
        if let nativeFault {
            let counters = try JSONSerialization.jsonObject(with: JSONEncoder().encode(nativeFault)) as! [String: Any]
            object.merge(counters) { _, new in new }
        }
        if let nativeConnections { object["connectionsCreated"] = nativeConnections }
        if let expiryFault {
            let counters = try JSONSerialization.jsonObject(with: JSONEncoder().encode(expiryFault)) as! [String: Any]
            object.merge(counters) { _, new in new }
        }
        if let rollbackApplied { object["rollbackApplied"] = rollbackApplied }
        object["schema"] = scenario.telemetrySchema; object["type"] = "result"
        object["cleanupConfirmed"] = stop?.cleanupConfirmed ?? false
        if let report = stop?.drain.report {
            object["captureDrain"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(report))
        } else { object["captureDrain"] = NSNull() }
        object["departureOutcome"] = departure?.outcome ?? NSNull() as Any
        object["departureReason"] = departure?.reason ?? NSNull() as Any
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) + Data([10])
    }
}

/// Private create-new metadata file, separate from stdout and custody fd3.
public final class CalibrationTelemetry: @unchecked Sendable {
    private let lock = NSLock()
    private let sink: FileEvidenceSink
    private let scenario: CalibrationScenario
    public init(path: String, scenario: CalibrationScenario = .normal) throws {
        let url = URL(fileURLWithPath: path)
        self.scenario = scenario
        sink = try FileEvidenceSink(root: url.deletingLastPathComponent().path, filename: url.lastPathComponent, maxLineBytes: 4096)
    }
    public func barrier(_ name: CalibrationBarrier) throws {
        guard name != .transportWriteFault || [.confirmedCleanupWrite, .unconfirmedCleanupWrite].contains(scenario),
              name != .metadataClockFault || scenario == .metadataPrimary,
              name != .nativePrimaryFault || scenario == .nativePrimary,
              name != .nativeStopCompletionLate || scenario == .unconfirmedCleanupWrite,
              ![.wallRollback, .expiryTransportFault].contains(name) || scenario == .expiryRollback else { throw BridgeProcessError.invalidInput }
        let line = try JSONSerialization.data(withJSONObject: ["schema": scenario.telemetrySchema, "type": "barrier", "name": name.rawValue], options: [.sortedKeys]) + Data([10])
        try lock.withLock { try sink.append(line) }
    }
    public func result(counts: CalibrationCounts, stop: TimedMediaStopResult?, departure: BridgeCleanupStatus?, faults: FaultConnectionSnapshot? = nil,
                       metadataFault: MetadataFaultSnapshot? = nil, nativeFault: NativeFaultSnapshot? = nil,
                       nativeConnections: Int? = nil, expiryFault: ExpiryFaultConnectionSnapshot? = nil,
                       rollbackApplied: Bool? = nil) throws {
        let line = try CalibrationMetadata.result(counts: counts, stop: stop, departure: departure, scenario: scenario, faults: faults,
            metadataFault: metadataFault, nativeFault: nativeFault, nativeConnections: nativeConnections,
            expiryFault: expiryFault, rollbackApplied: rollbackApplied)
        try lock.withLock { try sink.append(line) }
    }
    public func close() throws { try lock.withLock { try sink.close() } }
}
