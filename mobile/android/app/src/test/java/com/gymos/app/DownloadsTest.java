package com.gymos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DownloadsTest {

    @Test
    public void keepsAnOrdinaryInvoiceName() {
        assertEquals("INV-2026-0001.pdf", Downloads.safeFileName("INV-2026-0001.pdf"));
    }

    @Test
    public void pathTraversalCannotLeaveTheDownloadsFolder() {
        String name = Downloads.safeFileName("../../data/data/com.gymos.app/evil.pdf");
        assertFalse(name.contains("/"));
        assertFalse(name.startsWith("."));
        assertTrue(name.endsWith("evil.pdf"));
        assertFalse(Downloads.safeFileName("..\\..\\evil.pdf").contains("\\"));
    }

    @Test
    public void reservedAndControlCharactersAreReplaced() {
        assertEquals("a_b_c_d_.pdf", Downloads.safeFileName("a:b*c?d.pdf"));
    }

    @Test
    public void emptyOrDotOnlyNamesFallBack() {
        assertEquals(Downloads.FALLBACK_NAME, Downloads.safeFileName(null));
        assertEquals(Downloads.FALLBACK_NAME, Downloads.safeFileName("   "));
        assertEquals(Downloads.FALLBACK_NAME, Downloads.safeFileName(".."));
    }

    @Test
    public void longNamesAreCutFromTheFrontSoTheExtensionSurvives() {
        StringBuilder longName = new StringBuilder();
        for (int i = 0; i < 300; i++) {
            longName.append('x');
        }
        String name = Downloads.safeFileName(longName + ".pdf");
        assertEquals(120, name.length());
        assertTrue(name.endsWith(".pdf"));
    }
}
