from playwright.sync_api import sync_playwright
import time
import os

os.makedirs("artifacts/evidence/result_page", exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    
    # 1. Open result page
    page.goto("http://127.0.0.1:18280/result/index.html")
    time.sleep(1)
    
    # 2. If login is visible, enter password
    if page.locator("#login").is_visible():
        page.fill("#password", os.environ['EDUMASTER_ACCESS_CODE'])
        page.click("#login-form button")
        time.sleep(2)
        
    # Wait for archive to show
    page.wait_for_selector("#archive:not([hidden])", timeout=5000)
    page.wait_for_selector(".item", timeout=5000)
    
    # 3. Take screenshot of full archive page
    page.screenshot(path="artifacts/evidence/result_page/result_archive_all.png", full_page=True)
    print("Screenshot 1: result_archive_all.png saved!")
    
    # 4. Click filter: Gemma
    page.click("button[data-filter='gemma']")
    time.sleep(0.5)
    page.screenshot(path="artifacts/evidence/result_page/result_archive_gemma.png")
    print("Screenshot 2: result_archive_gemma.png saved!")
    
    # 5. Click filter: Gemini
    page.click("button[data-filter='gemini']")
    time.sleep(0.5)
    page.screenshot(path="artifacts/evidence/result_page/result_archive_gemini.png")
    print("Screenshot 3: result_archive_gemini.png saved!")
    
    # 6. Click '문제·해설 보기' to open modal
    page.click("button:has-text('문제·해설 보기')")
    time.sleep(0.5)
    page.screenshot(path="artifacts/evidence/result_page/result_modal_problem.png")
    print("Screenshot 4: result_modal_problem.png saved!")
    
    # Click '정답 및 상세 해설' tab in modal
    page.click("button.modal-tab:has-text('정답 및 상세 해설')")
    time.sleep(0.5)
    page.screenshot(path="artifacts/evidence/result_page/result_modal_explanation.png")
    print("Screenshot 5: result_modal_explanation.png saved!")
    
    browser.close()
    print("All Playwright verifications passed!")
