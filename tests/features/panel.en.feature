Feature: Complete Embedded MockTools Panel behavior
  In order to evolve the Panel without breaking interception or persistence
  As a developer
  I want every user feature, failure path, and fallback path to have a verifiable specification

  Background:
    Given the test page has loaded the unmodified "devtools-panel.js"
    And IndexedDB, localStorage, Service Worker, and network stubs are isolated before every scenario

  # Initialization and rendering

  @init @PANEL-001
  Scenario: Initialize for the first time with defaults
    When I call "MockTools.init()"
    Then the page should mount one open-mode Shadow DOM host
    And Fetch and XMLHttpRequest interceptors should be installed
    And the floating button should show zero requests and the current enabled Mock count

  @init @PANEL-002
  Scenario: Keep repeated initialization idempotent
    Given MockTools has completed initialization
    When I call "MockTools.init()" again
    Then it should return the same public API
    And it should not mount another host or wrap the network APIs again

  @init @PANEL-003
  Scenario: Open the Panel when native network APIs are absent
    Given the environment has neither Fetch nor XMLHttpRequest
    When MockTools is initialized
    Then the Panel should still mount
    And interceptor installation should not throw

  @init @PANEL-004
  Scenario Outline: Normalize a Seed Mock
    When MockTools is initialized with a Seed Mock containing "<input>"
    Then the normalized "<field>" should be "<result>"

    Examples:
      | input                    | field   | result                |
      | method=post              | method  | POST                  |
      | url=/api/users           | pattern | /api/users            |
      | body={"ok":true}        | body    | formatted JSON string |
      | enabled omitted          | enabled | true                  |
      | status=0                 | status  | 200                   |

  @init @PANEL-005
  Scenario Outline: Apply a preset floating-button position
    When the Panel is initialized with "<position>"
    Then the floating button should be at "<expected>"

    Examples:
      | position     | expected                  |
      | bottom-left  | 24px from bottom-left     |
      | bottom-right | 24px from bottom-right    |
      | top-left     | 24px from top-left        |
      | top-right    | 24px from top-right       |

  @init @PANEL-006
  Scenario: Apply an object floating-button position
    When the Panel is initialized with a left, right, top, and bottom object
    Then every supplied coordinate should be applied verbatim
    And every omitted coordinate should be auto

  # Persistence and reset

  @persistence @PANEL-007
  Scenario: Prefer IndexedDB Mocks over Seed Mocks
    Given IndexedDB stores Mock A
    And initialization contains Seed Mock B
    When persisted state hydration completes
    Then the Panel should use Mock A
    And Seed Mock B should not be merged into the result

  @persistence @PANEL-008
  Scenario: Migrate legacy localStorage Mocks to IndexedDB
    Given IndexedDB has no Mock record
    And legacy localStorage contains a valid Mock array
    When persisted Mocks are read
    Then the legacy Mocks should be written to IndexedDB
    And the legacy localStorage key should be removed

  @persistence @PANEL-009
  Scenario: Fall back to localStorage when IndexedDB reading fails
    Given IndexedDB open or read fails
    And localStorage contains valid Mocks
    When hydration completes
    Then in-memory state should use the localStorage Mocks
    And settings should expose a persistence error

  @persistence @PANEL-010
  Scenario: Preserve session state when all storage is unavailable
    Given IndexedDB and localStorage reads and writes all fail
    When the user adds and saves a Mock
    Then the Mock should remain usable for the current page session
    And the save failure should not stop Panel interactions

  @persistence @PANEL-011
  Scenario: Persist only the latest state during consecutive edits
    Given multiple Mock saves occur within 300ms
    When the debounced write completes
    Then final storage should equal the last state
    And any newly pending state should flush after the previous write

  @persistence @PANEL-012
  Scenario: Store Snapshots and active Snapshot ID through separate fallbacks
    Given IndexedDB Snapshot reads and writes fail
    When a Snapshot is saved and one Snapshot is activated
    Then the Snapshot list and active ID should be written to their localStorage keys

  @reset @PANEL-013
  Scenario: Cancel reset without changing state
    Given the Panel contains requests, Mocks, and Snapshots
    When the user cancels the reset confirmation
    Then in-memory and persisted state should remain unchanged

  @reset @PANEL-014
  Scenario: Confirm reset and clear all business data
    Given a Mock write is pending and a Snapshot is active
    When the user confirms reset
    Then the old write should finish before IndexedDB and localStorage are cleared
    And requests, Mocks, Snapshots, selection modes, and edit drafts should reset
    And the Service Worker should receive empty Mock and Snapshot state

  # Service Worker

  @service-worker @PANEL-015
  Scenario: Use in-page interception outside a secure context
    Given the page is not a secure HTTP context or Service Worker is unsupported
    When MockTools is initialized
    Then it should not register a Service Worker
    And Fetch and XHR Mocking should still work in the page

  @service-worker @PANEL-016
  Scenario: Try the root path after relative registration fails
    Given registration of "./mocktools-sw.js" fails
    When Service Worker setup runs
    Then it should also try to register "/mocktools-sw.js"

  @service-worker @PANEL-017
  Scenario: Synchronize rules after the Service Worker controls the page
    Given the Service Worker registers successfully and becomes controller
    When initialization completes or controllerchange fires
    Then the status badge should show Active
    And current Mocks and active Snapshot rules should be synchronized

  @service-worker @PANEL-018
  Scenario: Prevent the application from unregistering MockTools Service Worker
    Given a registration script URL points to mocktools-sw.js
    When the application calls unregister
    Then the call should return false
    And the underlying unregister should not execute

  @service-worker @PANEL-019
  Scenario: Recover after the application registers another Service Worker
    Given MockTools Service Worker mode is enabled
    When the application successfully registers another Service Worker
    Then MockTools should attempt to restore its controller after a short delay

  @service-worker @PANEL-020
  Scenario Outline: Recover the controller after lifecycle events
    Given the current controller is not MockTools Service Worker
    When "<event>" occurs
    Then registration should be updated and CLAIM_CLIENT sent to the active Worker

    Examples:
      | event                        |
      | window focus                 |
      | document visibility=visible  |
      | controllerchange             |

  @service-worker @PANEL-021
  Scenario: Send Mock synchronization to every unique Worker state
    Given controller, active, waiting, and installing contain duplicate Worker references
    When Mocks are synchronized
    Then every unique Worker should receive one MOCKTOOLS_UPDATE_MOCKS with an increasing version
    And the message Mocks should be empty when global Mocking is disabled

  @service-worker @PANEL-022
  Scenario: Fall back without stopping the Panel when recovery fails
    Given registration, update, or ready waiting fails
    When setup or recovery runs
    Then Service Worker state should become unavailable
    And in-page Fetch and XHR interception should continue working

  # Fetch

  @fetch @PANEL-023
  Scenario: Pass through an unmatched Fetch and record its response
    Given no Mock or Snapshot matches
    When Fetch returns a successful response
    Then original Fetch should receive the original arguments
    And the request record should contain status, duration, response headers, and response body
    And the Response returned to the application should remain readable

  @fetch @PANEL-024
  Scenario: Return a normal Mock for Fetch
    Given in-page interception has a matching enabled Mock
    When Fetch is called
    Then original Fetch should not be called
    And Mock status, headers, and body should be returned after the configured delay
    And the response should contain x-mocktools-mocked and mock-id markers

  @fetch @PANEL-025
  Scenario: Prefer a Snapshot over a normal Mock
    Given an active Snapshot and a normal Mock both match the request
    When Fetch is called
    Then the current Snapshot step should be returned
    And the record should be marked both mocked and snapshotted

  @fetch @PANEL-026
  Scenario: Avoid double Mocking while Service Worker controls the page
    Given MockTools Service Worker is controlling the page
    When a matching request receives a marked Worker response
    Then the in-page interceptor should call original Fetch
    And Mock and Snapshot source should be recorded only from response headers

  @fetch @PANEL-027
  Scenario: Record and rethrow a Fetch network error
    Given original Fetch throws an error with a message
    When intercepted Fetch is called
    Then the request record status should be the error status or zero
    And error message and duration should be recorded
    And the same error should be rethrown to the caller

  @fetch @PANEL-028
  Scenario: Do not leave a request pending when body clone or reading fails
    Given Fetch returned a status but clone or body reading fails
    When the response is recorded
    Then status and response headers should be committed first
    And the record should contain the body-reading error
    And status should not remain pending

  @fetch @PANEL-029
  Scenario Outline: Read response bodies safely by type and size
    Given the response is "<type>"
    When its body is read for logging
    Then the logged body should be "<result>"

    Examples:
      | type                                  | result                              |
      | application/octet-stream              | [binary response]                   |
      | short text without ReadableStream     | full text                           |
      | over 256 KiB without ReadableStream   | truncated text and truncated marker |
      | ReadableStream over 256 KiB            | canceled reader and truncated marker|

  @fetch @PANEL-030
  Scenario Outline: Serialize common Fetch request inputs
    When Fetch uses "<input>"
    Then request record "<field>" should be "<result>"

    Examples:
      | input                 | field        | result                        |
      | Request object        | method/url   | values from Request           |
      | init.method override  | method       | uppercase override            |
      | URLSearchParams       | requestBody  | query string                  |
      | FormData              | requestBody  | [FormData]                    |
      | Blob                  | requestBody  | placeholder containing MIME   |
      | circular object       | requestBody  | String fallback               |

  # XMLHttpRequest

  @xhr @PANEL-031
  Scenario: Pass through unmatched XHR and record loadend
    Given no rule matches
    When the application calls open, setRequestHeader, and send
    Then original methods should receive all arguments
    And after loadend the record should contain request headers, request body, status, response headers, and response body

  @xhr @PANEL-032
  Scenario: Simulate the complete event flow for a Mock XHR
    Given in-page interception has a matching Mock
    When XHR is sent
    Then original send should not be called
    And readyState, status, statusText, response, and responseText should be set after the delay
    And readystatechange, load, and loadend should be dispatched in order

  @xhr @PANEL-033
  Scenario: Mark an XHR Snapshot response
    Given the active Snapshot matches the XHR
    When XHR is sent
    Then response headers should include mocked, snapshotted, and rule ID
    And the request record should identify the Snapshot source

  @xhr @PANEL-034
  Scenario: Record an XHR network error
    Given original XHR dispatches error
    When the error occurs
    Then the request record should contain "XHR network error", status, and duration

  @xhr @PANEL-035
  Scenario: Fall back to assignment when readonly XHR properties reject defineProperty
    Given the test XHR rejects Object.defineProperty
    When a Mock XHR response is produced
    Then the implementation should try direct assignment
    And the event flow should still complete

  # Matching and exclusivity

  @matching @PANEL-036
  Scenario: Match a normal pattern as a URL substring
    Given a rule pattern is "/api/users"
    When the request URL contains that substring
    Then the rule should match
    And it should not match when the substring is absent

  @matching @PANEL-037
  Scenario: Match a valid slash-delimited regular expression
    Given the pattern is a valid "/regex/" form
    When different URLs are matched repeatedly
    Then regex lastIndex should reset before every match
    And results should remain stable

  @matching @PANEL-038
  Scenario: Fall back to literal substring matching for an invalid regex
    Given a slash-delimited pattern cannot compile
    When a URL is matched
    Then no exception should be thrown
    And includes should use the complete pattern string

  @matching @PANEL-039
  Scenario: Include exact Method and ALL Method candidates
    Given POST, GET, and ALL rules exist
    When a POST request is matched
    Then candidates should contain only POST and ALL rules
    And original array order should be retained for equal-priority decisions

  @matching @PANEL-040
  Scenario: Prefer the longest pattern and preserve order for equal lengths
    Given several enabled rules all match one request
    When a Mock is selected
    Then the rule with the longest pattern should win
    And for equal lengths the earlier array rule should win

  @matching @PANEL-041
  Scenario: Skip normal Mocks when the global Mock switch is off
    Given a matching rule is enabled
    But global Mocking is disabled
    When the request arrives
    Then normal Mock lookup should return no result
    And the request should pass through or be handled by a Snapshot

  @matching @PANEL-042
  Scenario: Allow only one active configuration per endpoint
    Given multiple configurations with the same method and pattern are enabled
    When they are initialized, imported, or one is activated
    Then the target configuration should remain enabled
    And all other configurations for that endpoint should be disabled
    And configurations for other endpoints should remain unchanged

  # Request history and Panel shell

  @history @PANEL-043
  Scenario: Keep at most 200 request records
    Given 200 requests have been recorded
    When request 201 is added
    Then the newest request should be first
    And the oldest request should be removed

  @history @PANEL-044
  Scenario: Combine URL, status, and sort filters
    Given the list contains records with different URLs, statuses, and times
    When a URL query, status query, and oldest sort are selected
    Then only records satisfying both filters should be shown
    And results should be ordered oldest to newest

  @history @PANEL-045
  Scenario: Show request details and source navigation
    Given a request contains request and response headers and bodies plus a valid mockId
    When the request is selected
    Then details should show method, URL, status, duration, and all code blocks
    And a navigation link should appear while the source still exists

  @history @PANEL-046
  Scenario: Keep the historical source label but disable navigation after deletion
    Given a record is marked Mock or Snapshot but its source rule was deleted
    When details render
    Then the historical source type should remain visible
    And no stale navigation rule ID should be exposed

  @history @PANEL-047
  Scenario: Clear selection together with request history
    Given a request is selected
    When Clear is clicked or clearRequests is called
    Then the request array should be empty
    And selectedId should be null and details should show an empty state

  @panel-shell @PANEL-048
  Scenario: Manage backdrop and page scrolling while opening and closing
    When the floating button opens the Panel
    Then the Panel and backdrop should be visible and body scrolling locked
    When Close, backdrop, or outside the Panel is clicked
    Then the Panel should close and the original body overflow should be restored

  @panel-shell @PANEL-049
  Scenario: Tuck and restore the floating button
    Given the pointer leaves the floating button past its idle timeout
    When the button is left-aligned or right-aligned
    Then it should tuck into the corresponding viewport edge and reduce opacity
    When the pointer enters again
    Then its original position, size, and opacity should be restored

  # Mock management

  @mock @PANEL-050
  Scenario: Add a default Mock rule
    When Add Mock is clicked
    Then an enabled GET /api/example rule should be created
    And the Mock edit dialog should open and the rule should persist

  @mock @PANEL-051
  Scenario: Create a Mock from a request
    Given a completed request exists
    When Create Mock is selected from its menu
    Then the new rule should inherit method, path, status, response headers, and response body
    And it should become the only active configuration for the endpoint

  @mock @PANEL-052
  Scenario: Save the Mock edit form
    Given name, enabled, method, pattern, status, delay, headers, and body were changed
    When Save is clicked
    Then all fields should be written back with their proper types
    And the active input should blur first to commit its latest value
    And saved feedback should remain visible for about 1.5 seconds

  @mock @PANEL-053
  Scenario: Preserve old Mock headers when Headers JSON is invalid
    Given the current rule has valid headers
    And the form headers are invalid JSON
    When the Mock is saved
    Then old headers should remain as fallback
    And other valid fields should still be saved

  @mock @PANEL-054
  Scenario: Add another configuration to an endpoint
    Given the endpoint has a source configuration
    When Add Config is clicked
    Then the new configuration should inherit method, pattern, group, and alias
    And default to disabled, status 200, delay zero, and empty body

  @mock @PANEL-055
  Scenario: Propagate endpoint-level edits to every configuration in the group
    Given an endpoint has multiple configurations
    When method, pattern, group, or aliasName is changed
    Then every configuration in the group should receive the field
    And single-active enforcement should be recalculated

  @mock @PANEL-056
  Scenario: Update editing values through quick fills, templates, and formatting
    When a status or delay quick value, response template, or Format is clicked
    Then the target input should receive the selected or formatted JSON value
    And valid JSON should show success while invalid JSON shows error feedback

  @mock @PANEL-057
  Scenario: Maintain selection after configuration, group, and bulk deletion
    Given multiple endpoint groups exist and current selection is among the targets
    When a configuration, a group, or selected groups are deleted
    Then only target rules should be removed
    And an invalid selectedMockId should be cleared
    And bulk selection mode should exit and persist

  # Snapshot management and playback

  @snapshot @PANEL-058
  Scenario: Create a Snapshot from selected completed requests
    Given several completed requests and one pending request are selected
    When a name is entered and the Snapshot is saved
    Then the pending request should be ignored
    And requests with the same method and pattern should form ordered response steps
    And the Panel should switch to the new Snapshot

  @snapshot @PANEL-059
  Scenario Outline: Handle Snapshot capture cancellation and empty results
    Given request selection mode is active
    When "<action>"
    Then "<result>"

    Examples:
      | action                  | result                                  |
      | save is canceled        | exit mode without creating a Snapshot   |
      | prompt returns empty    | keep data unchanged                     |
      | no completed requests   | alert and do not create a Snapshot       |
      | All then None is clicked| select all and then clear the selection  |

  @snapshot @PANEL-060
  Scenario: Prefer Snapshot playback and reset cursors after active changes
    Given an active Snapshot and a normal Mock exist
    When a request matches and then the active Snapshot is switched or disabled
    Then the Snapshot should answer first
    And playbackIndices should clear when active state changes

  @snapshot @PANEL-061
  Scenario Outline: Apply overflow behavior after Snapshot steps are exhausted
    Given all response steps have been consumed
    And overflow is "<mode>"
    When another request arrives
    Then it should "<result>"

    Examples:
      | mode        | result                                      |
      | repeat-last | repeat the final step                       |
      | loop        | return step one and continue from step two |
      | bypass      | return no Snapshot and use Mock or network |

  @snapshot @PANEL-062
  Scenario: Edit a Snapshot through a deep-copy draft
    Given a saved Snapshot is selected
    When name, rule method, pattern, or overflow changes without saving
    Then the original Snapshot should remain unchanged
    And Cancel should recreate the draft from the original Snapshot

  @snapshot @PANEL-063
  Scenario: Add, delete, and move Snapshot rules
    Given a Snapshot is being edited
    When a rule is added, deleted, moved up, or moved down
    Then the rules array and selectedSnapshotRuleIdx should stay consistent
    And the first item cannot move up and the last item cannot move down

  @snapshot @PANEL-064
  Scenario: Clone the final step when adding and only remove the target step
    Given a rule has a response step with headers
    When another step is added
    Then status, delay, headers, and body should be deep-copied
    When one step is deleted
    Then all other steps should remain unchanged

  @snapshot @PANEL-065
  Scenario: Synchronize Service Worker when saving the active Snapshot
    Given the edited Snapshot is active
    When a valid draft is saved
    Then the persisted list should replace the corresponding Snapshot
    And Service Worker should receive the updated rules
    And saved feedback should remain visible for about 1.5 seconds

  @snapshot @PANEL-066
  Scenario: Delete or bulk-delete the active Snapshot
    Given the deletion set includes the active and selected Snapshot
    When the user confirms deletion
    Then active ID and playback cursors should clear
    And the first remaining Snapshot or null should become selected
    And storage and Service Worker should be synchronized

  # Import and export

  @backup @PANEL-067
  Scenario: Export all Mocks as versioned JSON
    When Mocks are exported
    Then the download should contain version, exportedAt, and mocks
    And the filename should contain the current date
    And the temporary Object URL should be revoked

  @backup @PANEL-068
  Scenario Outline: Import supported Mock file shapes
    Given the selected JSON file is "<shape>"
    When Mocks are imported
    Then rules should be normalized and single-active enforcement applied

    Examples:
      | shape                     |
      | top-level Mock array      |
      | object with mocks array   |

  @backup @PANEL-069
  Scenario: Preserve current Mocks after an invalid import
    Given the file is not JSON or contains no Mock array
    When import is attempted
    Then an Import failed alert should appear
    And existing Mocks should not be replaced

  @backup @PANEL-070
  Scenario: Export one Snapshot and all Snapshots
    Given a Snapshot name contains special characters
    When one Snapshot and then all Snapshots are exported
    Then special filename characters should become underscores for the single export
    And payloads should contain snapshot and snapshots respectively
    And exporting all from an empty list should not download a file

  @backup @PANEL-071
  Scenario: Validate Snapshot imports and regenerate IDs
    Given a file contains one snapshot, a snapshots array, or a top-level array
    When items with valid name and rules are imported
    Then every Snapshot and every rule should receive a new ID
    And invalid items should be filtered and a fully invalid file should alert

  # Settings, rendering, utilities, and public API

  @settings @PANEL-072
  Scenario: Show storage and Service Worker state in Settings
    When Settings opens
    Then storage estimate should refresh
    And remaining quota or Estimate unavailable should be shown
    And Service Worker Active or fallback state plus version should be shown

  @rendering @PANEL-073
  Scenario: Highlight objects, arrays, and plain text safely
    Given code block values include valid JSON and non-JSON text
    When details render
    Then valid JSON should be formatted and distinguish key, string, number, boolean, and null
    And plain text should be escaped and displayed verbatim

  @security @PANEL-074
  Scenario: Escape all user-controlled text in HTML and attributes
    Given URLs, rule names, groups, headers, or bodies contain HTML, quotes, and backticks
    When the Panel renders
    Then no injected element, event handler, or script should be created
    And selector escaping should locate IDs containing special characters

  @utility @PANEL-075
  Scenario Outline: Parse Headers input by priority
    When "<input>" is parsed
    Then the result should be "<result>"

    Examples:
      | input                         | result                    |
      | {"x-a":"1"}                | JSON object               |
      | ({"x-a":"1"})              | loose object literal      |
      | x-a: 1 newline x-b: 2         | raw Header key-value map  |
      | empty string                  | empty object              |
      | unparseable without colon     | caller fallback           |

  @utility @PANEL-076
  Scenario: Keep the Panel stable after clipboard success or failure
    Given clipboard.writeText resolves or rejects
    When a code-block Copy button is clicked
    Then success should briefly show the copied state
    And failure should not change business state or reinitialize the Panel

  @rendering @PANEL-077
  Scenario: Restore focus, selection, scrolling, and collapsed state after rerender
    Given the user is editing a search, rule, or Snapshot field and has scrolled the regions
    When a new request triggers a notify rerender
    Then supported inputs should restore focus and selection range
    And list, details, textarea scroll positions, and collapsed sections should remain

  @utility @PANEL-078
  Scenario: Coalesce multiple notify calls in one animation frame
    Given notify is called repeatedly in one frame
    When the requestAnimationFrame callback executes
    Then every subscriber should render only once
    And setTimeout should be used when requestAnimationFrame is unavailable

  @api @PANEL-079
  Scenario: Use public addMock and getMocks APIs
    When addMock receives an unnormalized rule
    Then the rule should normalize, select, persist, and synchronize to Service Worker
    And getMocks should return a new array instead of the internal array reference

  @api @PANEL-080
  Scenario: Use public getRequests and clearRequests APIs
    Given request records exist and one is selected
    When getRequests is called
    Then a new array should preserve record order
    When clearRequests is called
    Then records and selection should clear and rendering should be notified
