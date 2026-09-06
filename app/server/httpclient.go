package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"time"
)

// Both exchanges sometimes answer 200 with an HTML page (rate-limited /
// blocked / captcha), not an error status - so every response body has to be
// sniffed before it's trusted, not just checked for status 200. Verified
// against Hawkeye's working Python implementation (nse/http_client.py,
// bse_pipeline.py), which found this to be true in practice for both sites.
func looksLikeBlockPage(body []byte) bool {
	head := strings.ToLower(string(body[:min(len(body), 2048)]))
	if strings.Contains(head, "<!doctype html") || strings.Contains(head, "<html") {
		return true
	}
	for _, marker := range []string{"access denied", "captcha", "akamai", "forbidden", "no record found"} {
		if strings.Contains(head, marker) {
			return true
		}
	}
	return false
}

// nseArchiveClient hits nsearchives.nseindia.com (bhavcopy zips, MTO delivery
// files) - no cookies or Referer needed there per Hawkeye's production path.
var nseArchiveClient = &http.Client{
	Timeout: 30 * time.Second,
}

func nseArchiveGet(url string) ([]byte, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ProjectXResearch/0.1; personal market research)")
	req.Header.Set("Accept", "text/csv,text/plain,application/octet-stream,application/zip,*/*;q=0.5")
	return doAndValidate(nseArchiveClient, req)
}

// nseAPIClient hits www.nseindia.com/api/historicalOR/... (bulk/block/short
// deals range queries). That host requires a cookie bootstrap first - warm
// a session by loading the human-facing report page on this same client (and
// therefore its cookie jar) before calling the API.
var nseAPIClient = mustCookieClient()

func mustCookieClient() *http.Client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		panic(err)
	}
	return &http.Client{Timeout: 30 * time.Second, Jar: jar}
}

var nseSessionWarmed bool

func nseAPIGet(url string) ([]byte, error) {
	if !nseSessionWarmed {
		req, _ := http.NewRequest("GET", "https://www.nseindia.com/report-detail/display-bulk-and-block-deals", nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ProjectXResearch/0.1; personal market research)")
		req.Header.Set("Accept", "text/html,*/*;q=0.5")
		if resp, err := nseAPIClient.Do(req); err == nil {
			resp.Body.Close()
			nseSessionWarmed = true
		}
		// Best-effort: Hawkeye's own backfill swallows this failure too and
		// tries the real request anyway.
	}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ProjectXResearch/0.1; personal market research)")
	req.Header.Set("Accept", "text/csv,text/plain,*/*;q=0.5")
	return doAndValidate(nseAPIClient, req)
}

// bseClient covers both www.bseindia.com file downloads and the
// api.bseindia.com JSON endpoints - same browser-shaped UA and static
// Referer on every request, no cookies needed, per Hawkeye's working path.
var bseClient = &http.Client{Timeout: 35 * time.Second}

func bseGet(url string) ([]byte, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Referer", "https://www.bseindia.com/markets/MarketInfo/BhavCopy.aspx")
	return doAndValidate(bseClient, req)
}

// doAndValidate runs the request with a small retry-on-429/5xx budget (both
// exchanges' documented behavior: retry on rate-limit/server error, never on
// 403/404 - those are terminal per Hawkeye's classification) and rejects
// bodies that look like an HTML block page rather than real data.
func doAndValidate(client *http.Client, req *http.Request) ([]byte, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
			continue
		}
		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		switch {
		case resp.StatusCode == 403:
			return nil, fmt.Errorf("blocked (403) fetching %s", req.URL)
		case resp.StatusCode == 404:
			return nil, fmt.Errorf("not available (404) fetching %s", req.URL)
		case resp.StatusCode == 429 || resp.StatusCode >= 500:
			lastErr = fmt.Errorf("status %d fetching %s", resp.StatusCode, req.URL)
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
			continue
		case resp.StatusCode != 200:
			return nil, fmt.Errorf("status %d fetching %s", resp.StatusCode, req.URL)
		}
		if looksLikeBlockPage(body) {
			return nil, fmt.Errorf("blocked or empty response from %s", req.URL)
		}
		return body, nil
	}
	return nil, lastErr
}

func isZip(body []byte) bool {
	return bytes.HasPrefix(body, []byte("PK"))
}
