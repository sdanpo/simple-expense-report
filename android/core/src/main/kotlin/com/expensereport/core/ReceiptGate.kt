package com.expensereport.core

/**
 * Cheap, on-device features extracted from a photo's OCR text + dimensions. The app
 * gets `ocrText` from ML Kit on-device text recognition (~0.1 J/photo); everything
 * here is pure string math so it is fully unit-testable off-device.
 */
data class ImageTextFeatures(
    val totalChars: Int,
    val lineCount: Int,
    val digitRatio: Double,        // fraction of characters that are digits
    val hasCurrencySymbol: Boolean,
    val hasAmountPattern: Boolean, // e.g. 42.50 / 1,234.00
    val keywordHits: Int,          // distinct receipt-ish keywords found
    val aspectRatio: Double        // height/width (receipts tend to be tall)
)

/**
 * The on-device gate. Its only job is to PERMISSIVELY discard obvious non-receipts
 * (selfies, landscapes, blank shots) so we don't upload them. It favors RECALL: a
 * single strong signal is enough to pass. The server (Gemini) is the authoritative
 * classifier, so a false positive only costs one upload, while a false negative
 * loses a receipt — which we must avoid.
 */
object ReceiptGate {

    val KEYWORDS = listOf(
        // English
        "invoice", "receipt", "total", "subtotal", "tax", "vat", "amount", "paid", "change", "cash", "card",
        // Hebrew
        "חשבונית", "קבלה", "סה\"כ", "מע\"מ", "תשלום", "מזומן"
    )

    private val AMOUNT = Regex("""\d{1,3}(?:[.,]\d{3})*[.,]\d{2}""")
    private val CURRENCY = Regex("""[₪$€£]|\b(?:ILS|USD|EUR|GBP|NIS)\b""", RegexOption.IGNORE_CASE)

    fun extractFeatures(ocrText: String, widthPx: Int, heightPx: Int): ImageTextFeatures {
        val total = ocrText.length
        val digits = ocrText.count { it.isDigit() }
        val lines = if (ocrText.isBlank()) 0 else ocrText.split('\n').count { it.isNotBlank() }
        val lower = ocrText.lowercase()
        val hits = KEYWORDS.count { lower.contains(it.lowercase()) }
        val aspect = if (widthPx > 0) heightPx.toDouble() / widthPx.toDouble() else 0.0
        return ImageTextFeatures(
            totalChars = total,
            lineCount = lines,
            digitRatio = if (total > 0) digits.toDouble() / total else 0.0,
            hasCurrencySymbol = CURRENCY.containsMatchIn(ocrText),
            hasAmountPattern = AMOUNT.containsMatchIn(ocrText),
            keywordHits = hits,
            aspectRatio = aspect
        )
    }

    /** Receipt-likelihood in [0,1]. Tuned permissively. */
    fun score(f: ImageTextFeatures): Double {
        var s = 0.0
        if (f.hasAmountPattern) s += 0.45        // a money amount is the strongest single cue
        if (f.hasCurrencySymbol) s += 0.25
        s += minOf(f.keywordHits, 3) * 0.12      // up to +0.36
        if (f.totalChars >= 80) s += 0.12        // real documents carry lots of text
        if (f.lineCount >= 6) s += 0.08
        if (f.digitRatio >= 0.08) s += 0.05
        return s.coerceIn(0.0, 1.0)
    }

    const val DEFAULT_THRESHOLD = 0.45

    /** Permissive: an amount pattern alone (0.45) already qualifies. */
    fun isCandidate(f: ImageTextFeatures, threshold: Double = DEFAULT_THRESHOLD): Boolean =
        score(f) >= threshold

    /** Convenience: OCR text + dimensions straight to a verdict. */
    fun isCandidate(ocrText: String, widthPx: Int, heightPx: Int, threshold: Double = DEFAULT_THRESHOLD): Boolean =
        isCandidate(extractFeatures(ocrText, widthPx, heightPx), threshold)
}
