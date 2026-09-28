import json
import os
import asyncio
from playwright.async_api import async_playwright

async def capture():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 1100})
        # Pre-set authentication in localStorage
        code = json.dumps(os.environ['EDUMASTER_ACCESS_CODE'])
        await context.add_init_script(f"localStorage.setItem('edumaster-access', {code}); sessionStorage.setItem('edumaster-access', {code});")
        page = await context.new_page()
        
        print("Navigating to https://minohlee.mooo.com/edumaster/result/...")
        await page.goto("https://minohlee.mooo.com/edumaster/result/", wait_until="domcontentloaded", timeout=15000)
        
        # Wait for archive to be visible
        try:
            await page.wait_for_selector("#archive:not([hidden])", timeout=10000)
        except Exception:
            if await page.is_visible("#login"):
                print("Logging in...")
                await page.fill("#password", os.environ['EDUMASTER_ACCESS_CODE'])
                await page.click("#login-form button")
                await page.wait_for_selector("#archive:not([hidden])", timeout=10000)
                
        # Wait for items to render
        await page.wait_for_selector(".item", timeout=10000)
        await asyncio.sleep(1)
            
        print("Taking main result page screenshot...")
        await page.screenshot(path="artifacts/result_page_live.png", full_page=True)
        
        # Click the GPT simulation result to verify its detailed data.
        first_detail_btn = await page.query_selector(".item[data-model='gpt'] .actions button.secondary")
        if first_detail_btn:
            print("Clicking detail modal button for GPT simulation...")
            await first_detail_btn.click()
            await page.wait_for_selector("#detail-modal[open]", timeout=5000)
            await asyncio.sleep(0.5)
            assert "⑤ ㄱ, ㄴ, ㄷ" in await page.locator("#modal-answer").inner_text()
            assert "GPT" in await page.locator("#modal-model-badge").inner_text()
            await page.screenshot(path="artifacts/modal_problem_live.png")
            
            # Switch to source image tab
            source_tab = await page.query_selector(".modal-tab[data-tab='source']")
            if source_tab:
                print("Switching to source image tab in modal...")
                await source_tab.click()
                await asyncio.sleep(0.5)
                await page.screenshot(path="artifacts/modal_source_live.png")
                
        await browser.close()
        print("Screenshots captured successfully.")

asyncio.run(capture())
