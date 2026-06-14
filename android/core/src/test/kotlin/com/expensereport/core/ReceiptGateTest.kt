package com.expensereport.core

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ReceiptGateTest {

    private val realReceipt = """
        SUPER-PHARM
        Tax Invoice / Receipt 00123
        Shampoo        18.90
        Toothpaste     12.50
        Subtotal       31.40
        VAT 17%         5.34
        TOTAL          36.74 ₪
        Paid by card
    """.trimIndent()

    @Test fun acceptsAClearReceipt() {
        assertTrue(ReceiptGate.isCandidate(realReceipt, 1080, 1920))
    }

    @Test fun acceptsHebrewReceipt() {
        val heb = "חשבונית מס קבלה\nסה\"כ לתשלום 142.00 ₪\nמע\"מ 20.64"
        assertTrue(ReceiptGate.isCandidate(heb, 1080, 1920))
    }

    @Test fun rejectsASelfieWithNoText() {
        assertFalse(ReceiptGate.isCandidate("", 1920, 1080))
    }

    @Test fun rejectsAShortCaptionWithoutMoneyCues() {
        assertFalse(ReceiptGate.isCandidate("Sunset at the beach", 1920, 1080))
    }

    @Test fun permissive_anAmountPatternAloneQualifies() {
        // No keywords, no currency symbol — just a money-shaped number. Recall > precision.
        val f = ReceiptGate.extractFeatures("random note 42.50 here", 1000, 1000)
        assertTrue(ReceiptGate.isCandidate(f))
    }

    @Test fun currencyPlusAmountQualifies() {
        assertTrue(ReceiptGate.isCandidate("Total $19.99", 1000, 1400))
    }

    @Test fun scoreIsBoundedToUnitInterval() {
        val s = ReceiptGate.score(ReceiptGate.extractFeatures(realReceipt, 1080, 1920))
        assertTrue(s in 0.0..1.0)
    }

    @Test fun extractFeaturesCountsDigitsAndLines() {
        val f = ReceiptGate.extractFeatures("a1\nb2\n\nc3", 100, 200)
        // 3 non-blank lines, 3 digits of 6 non-newline chars
        kotlin.test.assertEquals(3, f.lineCount)
        assertTrue(f.digitRatio > 0.3)
        kotlin.test.assertEquals(2.0, f.aspectRatio)
    }
}
