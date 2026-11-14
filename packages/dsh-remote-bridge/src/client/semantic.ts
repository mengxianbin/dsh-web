/**
 * Semantic attribute values for the protocol v1 pairing panel (contract:
 * skins/skin-center/contracts/semantic-attrs-v1.md). Root containers carry
 * `data-dsh-plugin`; parts carry bare `data-dsh-part` values owned by that
 * plugin attribute.
 */

/** Plugin short name stamped on the footer trigger and the modal root. */
export const PLUGIN_ATTR = 'remote-bridge'

/** The sidebar footer seat trigger. */
export const PART_ENTRY = 'entry'

/** The modal panel root. */
export const PART_PANEL = 'panel'

/** The QR symbol's box — it also mirrors the encoded string. */
export const PART_QR = 'qr'

/** A refusal the host raised. */
export const PART_NOTICE = 'notice'

/** The mint-again button. */
export const PART_REFRESH = 'refresh'

/** The copy-the-code button. */
export const PART_COPY = 'copy'

/**
 * Attribute carrying the exact string the QR symbol encodes, so the operator
 * (and a UI check) can compare it against the host route's answer without
 * decoding the symbol. It is the only machine trace the panel renders.
 */
export const QR_VALUE_ATTR = 'data-dsh-qr-value'

/**
 * Marks the QR part of a code that has run out of time. Expiry is state on the
 * existing part, not a new part value: the cross-repository part enum is frozen
 * and a plugin may not extend it for one visual state.
 */
export const EXPIRED_ATTR = 'data-expired'
