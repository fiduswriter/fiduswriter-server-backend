import {E2EEKeyManager} from "fwtoolkit/e2ee/key-manager"
import {PassphraseManager} from "fwtoolkit/e2ee/passphrase-manager"

/**
 * Generate fresh E2EE options for a newly imported chapter.
 *
 * When the user's passphrase keys are unlocked in the session a random
 * document password (raw DEK) is generated so it can later be saved to the
 * server.  Otherwise a random 32-byte DEK is generated directly.
 */
export async function generateE2EEOptions(): Promise<{
    options: E2EEOptions
    password: string
}> {
    const hasPassphraseKeys = await PassphraseManager.hasEncryptionKeys()
    const passphraseInSession =
        hasPassphraseKeys && PassphraseManager.hasKeysInSession()

    let password: string
    if (passphraseInSession) {
        password = await PassphraseManager.generateDocumentPassword()
    } else {
        const rawKey = crypto.getRandomValues(new Uint8Array(32))
        password = btoa(String.fromCharCode(...rawKey))
    }

    const salt = E2EEKeyManager.generateSalt()
    const saltBase64 = btoa(String.fromCharCode(...salt))
    const iterations = 600000

    const key = await PassphraseManager.resolvePasswordToKey(
        password,
        salt,
        iterations
    )

    return {
        options: {enabled: true, key, salt: saltBase64, iterations},
        password
    }
}

/** The E2EE options handed to the native importer for a new chapter. */
interface E2EEOptions {
    enabled: boolean
    key: CryptoKey
    salt: string
    iterations: number
}

/** The subset of a document the importer hands back. */
interface ImportedDoc {
    id: number
}

/**
 * Persist an imported chapter's E2EE password so it survives the current
 * session and, when passphrase keys are available, future sessions.
 *
 * @param doc - Imported chapter document.
 * @param password - Raw document password.
 */
export async function storeImportedE2EEPassword(
    doc: ImportedDoc,
    password: string
): Promise<void> {
    E2EEKeyManager.storePasswordInSession(doc.id, password)

    const hasPassphraseKeys = await PassphraseManager.hasEncryptionKeys()
    const passphraseInSession =
        hasPassphraseKeys && PassphraseManager.hasKeysInSession()

    if (passphraseInSession) {
        try {
            await PassphraseManager.saveDocumentPassword(
                doc.id,
                password,
                null,
                "user",
                true
            )
        } catch (_e) {
            // Non-fatal: the key is still cached for this session.
        }
    }
}
