package com.expensereport.core

import kotlin.test.Test
import kotlin.test.assertEquals

class UploadOutcomeTest {
    @Test fun success2xx() {
        assertEquals(UploadDecision.TERMINAL_SUCCESS, UploadOutcome.fromHttpStatus(200))
        assertEquals(UploadDecision.TERMINAL_SUCCESS, UploadOutcome.fromHttpStatus(201))
        assertEquals(UploadDecision.TERMINAL_SUCCESS, UploadOutcome.fromHttpStatus(299))
    }

    @Test fun reauthOn401() {
        assertEquals(UploadDecision.REAUTH, UploadOutcome.fromHttpStatus(401))
    }

    @Test fun dropOnTerminalClientErrors() {
        assertEquals(UploadDecision.TERMINAL_DROP, UploadOutcome.fromHttpStatus(400))
        assertEquals(UploadDecision.TERMINAL_DROP, UploadOutcome.fromHttpStatus(413))
        assertEquals(UploadDecision.TERMINAL_DROP, UploadOutcome.fromHttpStatus(404))
    }

    @Test fun retryOnTransient() {
        for (s in listOf(408, 429, 500, 502, 503, 504)) {
            assertEquals(UploadDecision.RETRY, UploadOutcome.fromHttpStatus(s), "status $s")
        }
    }

    @Test fun retryOnNetworkFailure() {
        assertEquals(UploadDecision.RETRY, UploadOutcome.fromHttpStatus(null))
    }
}
