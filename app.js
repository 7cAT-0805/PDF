import { GoogleGenerativeAI } from '@google/generative-ai';

// 設定 PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.worker.min.js';

document.addEventListener('DOMContentLoaded', function() {
    // PDF 相關元素
    const fileInput = document.getElementById('file-input');
    const uploadButton = document.getElementById('upload-button');
    const uploadContainer = document.querySelector('.upload-container'); // 獲取上傳容器
    const contentArea = document.querySelector('.content-area'); // 獲取內容區域
    const fileNameDisplay = document.getElementById('file-name');
    const pdfContainer = document.getElementById('pdf-container');
    const highlightOverlay = document.getElementById('pdf-highlight-overlay'); // 獲取高亮疊加層
    const loadingIndicator = document.getElementById('loading');
    const prevButton = document.getElementById('prev-page');
    const nextButton = document.getElementById('next-page');
    const pageCounter = document.getElementById('page-counter');
    const pdfViewer = document.getElementById('pdf-viewer');
    const noPdfMessage = document.getElementById('no-pdf-message');
    
    // 縮放按鈕
    const zoomInButton = document.getElementById('zoom-in');
    const zoomOutButton = document.getElementById('zoom-out');
    const zoomResetButton = document.getElementById('zoom-reset');
    
    // 聊天相關元素
    const chatInterface = document.querySelector('.ai-chat'); // 獲取聊天界面主容器
    const chatMessages = document.getElementById('chat-messages');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-message');
    
    // PDF 狀態變數
    let pdfDoc = null;
    let currentPage = 1;
    let totalPages = 0;
    let currentPdfImageParts = []; 
    let currentRenderScale = 1.5; // 用於追蹤用戶界面PDF的當前縮放比例
    const initialScaleForAI = 2.0; // 給AI分析的圖片固定縮放比例
    const minScale = 0.5; // 最小縮放
    const maxScale = 3.0; // 最大縮放
    const scaleStep = 0.25; // 縮放步長
    
    // 聊天記憶相關變數
    let pageChatSessions = {}; // 改為物件，以頁碼為鍵儲存聊天會話
    let pageMessageHistories = {}; // 新增：儲存每個頁面的訊息歷史
    // --- MODIFICATION START ---
    let pageHighlightSuggestions = {}; // 新增：儲存每頁的高亮建議 (This was already in your code)
    let isAnalyzingGlobal = false; // 新增：追蹤是否正在進行全局 PDF 分析
    // --- MODIFICATION END ---
    
    // 全局 Gemini AI 實例 和 API Key
    let genAI = null;
    const API_KEY = "AIzaSyBjVZQ3mibvi4vqcfbOMxDybDW06F_E8Fc"; // 請替換成您的 API Key
    try {
        genAI = new GoogleGenerativeAI(API_KEY);
    } catch (error) {
        console.error("無法初始化 GoogleGenerativeAI:", error);
        if (chatInterface) chatInterface.classList.remove('hidden');
        addMessage("AI服務初始化失敗，請檢查API金鑰或網路連線。", "ai");
        // 可以在此處禁用聊天功能或顯示更明顯的錯誤提示
    }
    // --- MODIFICATION END ---


    // 輔助函數：將Data URL轉換為Gemini API的Part格式
    function dataUrlToGenerativePart(dataUrl, mimeType) {
        // 從 data:image/jpeg;base64,xxxxxxxx 提取 xxxxxxxx 部分
        const base64Data = dataUrl.split(',')[1];
        return {
            inlineData: {
                data: base64Data,
                mimeType
            }
        };
    }

    // 輔助函數：將PDF每一頁渲染成圖片並轉換為Part
    async function renderPdfPagesToImageParts(pdfDocument, imageMimeType = 'image/jpeg', quality = 0.85) { 
        const imageParts = [];
        const numPagesToProcess = pdfDocument.numPages; 
        
        loadingIndicator.textContent = `正在處理PDF頁面為高清圖片 (0/${numPagesToProcess})...`;
        loadingIndicator.style.display = 'block';

        for (let i = 1; i <= numPagesToProcess; i++) {
            try {
                const page = await pdfDocument.getPage(i);
                const viewport = page.getViewport({ scale: initialScaleForAI }); // 使用固定的 initialScaleForAI
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                await page.render({ canvasContext: context, viewport: viewport }).promise;
                
                const dataUrl = canvas.toDataURL(imageMimeType, quality);
                imageParts.push(dataUrlToGenerativePart(dataUrl, imageMimeType));
                
                loadingIndicator.textContent = `正在處理PDF頁面為高清圖片 (${i}/${numPagesToProcess})...`;
                console.log(`已處理頁面 ${i} 為高清圖片`);

            } catch (error) {
                console.error(`處理PDF頁面 ${i} 為圖片時發生錯誤:`, error);
                // 可以選擇跳過此頁面或添加一個錯誤標記
            }
        }
        loadingIndicator.style.display = 'none';
        console.log(`所有 ${imageParts.length} 個頁面已轉換為圖片Part`);
        return imageParts;
    }


    // 點擊上傳按鈕時觸發文件選擇
    uploadButton.addEventListener('click', function() {
        fileInput.click();
    });
    
    // 導航按鈕事件
    prevButton.addEventListener('click', function() {
        if (currentPage > 1) {
            currentPage--;
            renderCurrentPage(true); // 翻頁時需要更新聊天記錄
        }
    });
    
    nextButton.addEventListener('click', function() {
        if (currentPage < totalPages) {
            currentPage++;
            renderCurrentPage(true); // 翻頁時需要更新聊天記錄
        }
    });
    
    // 當選擇文件後
    fileInput.addEventListener('change', async function(e) { 
        if (fileInput.files.length === 0) {
            return;
        }
        
        const file = fileInput.files[0];
        
        if (file.type !== 'application/pdf') {
            alert('請上傳 PDF 文件');
            fileInput.value = ''; 
            return;
        }
        
        fileNameDisplay.textContent = `已選擇: ${file.name}`;

        const existingPageCanvas = pdfContainer.querySelector('.pdf-page');
        if (existingPageCanvas) {
            existingPageCanvas.remove();
        }

        currentPdfImageParts = []; 
        pdfViewer.classList.add('active');
        pageChatSessions = {}; // 清空先前文件的聊天會話
        pageMessageHistories = {}; // 清空先前文件的訊息歷史
        pageHighlightSuggestions = {}; // 清空先前文件的高亮建議
        
        if (uploadContainer) {
            uploadContainer.classList.add('hidden');
        }
        if (contentArea) {
            contentArea.classList.add('full-screen');
        }
        
        if (chatMessages) {
            chatMessages.innerHTML = ''; 
        }

        if (chatInterface) {
            chatInterface.classList.remove('hidden');
        }
        
        if (noPdfMessage) {
            noPdfMessage.style.display = 'none';
        }
        
        loadingIndicator.textContent = '正在載入PDF...'; // 初始載入PDF的提示
        loadingIndicator.style.display = 'block';
        currentPage = 1;
        
        const fileReader = new FileReader();
        
        fileReader.onload = async function() { 
            const typedArray = new Uint8Array(this.result);
            
            try {
                pdfDoc = await pdfjsLib.getDocument(typedArray).promise;
                totalPages = pdfDoc.numPages;
                currentRenderScale = await calculateInitialScale(); // 改為 await
                loadingIndicator.textContent = `PDF 載入完成，共 ${totalPages} 頁。準備轉換為圖片...`;
                
                prevButton.disabled = currentPage === 1;
                nextButton.disabled = currentPage === totalPages;
                
                await renderCurrentPage(); // 渲染第一頁給用戶看

                currentPdfImageParts = await renderPdfPagesToImageParts(pdfDoc); // 這個函數內部會更新loadingIndicator

                if (currentPdfImageParts.length > 0) {
                    // --- MODIFICATION START ---
                    // 將初始訊息移到 analyzeAllPagesAndDisplayResults 調用之前                    
                    // 禁用聊天輸入由 analyzeAllPagesAndDisplayResults 內部處理開始和結束
                    await analyzeAllPagesAndDisplayResults(currentPdfImageParts, file.name);
                    // 啟用聊天輸入和最終訊息也移到 analyzeAllPagesAndDisplayResults 內部
                    // --- MODIFICATION END ---
                } else {
                    addMessage(`讀取PDF文件「${file.name}」時，未能成功轉換頁面為圖片。請檢查文件或嘗試其他文件。`, 'ai', currentPage); 
                    loadingIndicator.style.display = 'none'; // 轉換失敗，隱藏loading
                }
                // await initChatSession(); // 秘移至 analyzeAllPagesAndDisplayResults 內部調用 (現在是 initChatSessionForPage)

            } catch (error) {
                console.error('無法載入或處理 PDF:', error);
                loadingIndicator.textContent = '無法載入或處理 PDF 文件';
                addMessage('抱歉，處理您的PDF時發生錯誤。', 'ai', currentPage); 
                if (chatInterface && chatInterface.classList.contains('hidden')) { 
                    chatInterface.classList.remove('hidden');
                }
                loadingIndicator.style.display = 'none'; // 確保出錯時隱藏
                // --- MODIFICATION START ---
                // 出錯時也應確保聊天輸入可用或有提示
                messageInput.disabled = false;
                sendButton.disabled = false;
                // --- MODIFICATION END ---
            } 
            // --- MODIFICATION START ---
            // 移除 finally 中的 setTimeout，loadingIndicator 由 analyzeAllPagesAndDisplayResults 控制
            // --- MODIFICATION END ---


        };
        
        fileReader.readAsArrayBuffer(file);
    });
    
    // 提取PDF所有頁面的文本 (保留作為備用，但主要使用圖片)
    async function extractAllText(pdf) {
        let allText = "";
        console.log("開始提取PDF文字內容...");
        for (let i = 1; i <= pdf.numPages; i++) {
            try {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                // 將所有字串連接起來，並去除頭尾空格
                let pageText = textContent.items.map(item => item.str).join(' ').trim(); 

                // 記錄提取到的原始項目和處理後的文字
                // console.log(`頁面 ${i} 原始 textContent.items:`, JSON.parse(JSON.stringify(textContent.items))); // 深拷貝以利觀察
                console.log(`頁面 ${i} 提取到的文字 (trim後): "${pageText}"`);

                if (pageText.length > 0) {
                    // 使用更清晰的標記來分隔頁碼和內容
                    allText += `頁面 ${i} 的內容開始：\n${pageText}\n頁面 ${i} 的內容結束。\n\n`;
                } else {
                    allText += `頁面 ${i}：[此頁面沒有可提取的文字內容或內容為空]\n\n`;
                    console.warn(`頁面 ${i} 沒有提取到文字內容，或內容為空。`);
                }
            } catch (error) {
                console.error(`提取第 ${i} 頁文本時發生錯誤:`, error);
                allText += `頁面 ${i}：[提取此頁面文字時發生錯誤]\n\n`;
            }
        }
        console.log("PDF文字內容提取完成。");
        // console.log("完整提取文字:", allText); // 如果文字很多，這行可能會輸出大量資訊
        return allText;
    }
    
    // 計算初始渲染比例以適應容器 (確保 getPage(1) 前 pdfDoc 已賦值)
    async function calculateInitialScale() { // 改為 async
        if (!pdfDoc || !pdfContainer.clientWidth || !pdfContainer.clientHeight) return 1.0;
        
        try {
            const page = await pdfDoc.getPage(1); // 使用 await
            const viewportOriginal = page.getViewport({ scale: 1.0 });
            const paddingValue = 20 * 2; 
            const containerWidth = pdfContainer.clientWidth - paddingValue;
            const containerHeight = pdfContainer.clientHeight - paddingValue;
            const horizontalScale = containerWidth / viewportOriginal.width;
            const verticalScale = containerHeight / viewportOriginal.height;
            return Math.min(horizontalScale, verticalScale, maxScale);
        } catch (error) {
            console.error("計算初始縮放失敗:", error);
            return 1.0; 
        }
    }
    
    // 渲染當前頁面 (給用戶看的PDF渲染)
    async function renderCurrentPage(updateChatMessages = true) { 
        if (!pdfDoc) return;
        
        if (typeof currentRenderScale !== 'number') {
            currentRenderScale = await calculateInitialScale();
        }

        // 清空 pdfContainer 中除了 highlightOverlay 之外的內容
        const pageCanvas = pdfContainer.querySelector('.pdf-page');
        if (pageCanvas) pageCanvas.remove();
        
        pageCounter.textContent = `第 ${currentPage} 頁 / 共 ${totalPages} 頁 (縮放: ${Math.round(currentRenderScale * 100)}%)`;
        prevButton.disabled = currentPage === 1;
        nextButton.disabled = currentPage === totalPages;
        
        // --- MODIFICATION START ---
        let previousGlobalLoadingText = null;
        let wasGlobalIndicatorVisibleForAnalysis = false;

        if (isAnalyzingGlobal && loadingIndicator.style.display === 'block') {
            previousGlobalLoadingText = loadingIndicator.textContent;
            wasGlobalIndicatorVisibleForAnalysis = true;
        }
        
        loadingIndicator.textContent = `正在渲染第 ${currentPage} 頁...`;
        loadingIndicator.style.display = 'block'; 
        // --- MODIFICATION END ---
        
        pdfDoc.getPage(currentPage).then(function(page) {
            const scaledViewport = page.getViewport({ scale: currentRenderScale });
            
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = scaledViewport.height;
            canvas.width = scaledViewport.width;
            canvas.classList.add('pdf-page');
            
            // --- MODIFICATION START ---
            // Ensure highlightOverlay is present and a child of pdfContainer.
            // If pdfContainer was cleared in a way that removed highlightOverlay,
            // this would still be an issue. The fix in fileInput.onchange should prevent this.
            // The highlightOverlay is defined in HTML within pdfContainer.
            // We want the new page canvas to be before the highlight overlay in the DOM
            // so the overlay can draw on top (visually, z-index also matters).
            if (highlightOverlay && highlightOverlay.parentNode === pdfContainer) {
                 pdfContainer.insertBefore(canvas, highlightOverlay);
            } else {
                 // Fallback: if highlightOverlay is somehow not there or not a child, just append.
                 // This might mean highlighting won't work as expected.
                 console.warn("highlightOverlay not found as a child of pdfContainer, appending page canvas. Highlighting might be affected.");
                 pdfContainer.appendChild(canvas); 
                 // If highlightOverlay was removed, we might need to re-create or re-append it.
                 // For now, we assume the fix in fileInput.onchange is sufficient.
            }
            // --- MODIFICATION END ---
           

            // 設置高亮疊加層的尺寸與PDF Canvas一致
            if (highlightOverlay) {
                highlightOverlay.width = scaledViewport.width;
                highlightOverlay.height = scaledViewport.height;
                // 確保疊加層與Canvas對齊 (如果CSS的position:absolute和top/left不足夠)
                // highlightOverlay.style.position = 'absolute';
                // highlightOverlay.style.left = canvas.offsetLeft + 'px';
                // highlightOverlay.style.top = canvas.offsetTop + 'px';
                // 更好的方式是讓 pdf-container 的子元素自然疊加，並通過 z-index 控制
            }
            
            // 渲染 PDF 頁面到 Canvas
            const renderContext = {
                canvasContext: context,
                viewport: scaledViewport
            };
            
            page.render(renderContext).promise.then(() => {
                // --- MODIFICATION START ---
                if (wasGlobalIndicatorVisibleForAnalysis) {
                    // 如果全局分析仍在進行，恢復其進度文本，並保持可見
                    loadingIndicator.textContent = previousGlobalLoadingText;
                    loadingIndicator.style.display = 'block';
                } else if (!isAnalyzingGlobal) { 
                    // 只有當沒有全局分析時，渲染完成才隱藏指示器
                    loadingIndicator.style.display = 'none';
                }
                // 如果 isAnalyzingGlobal is true 但 wasGlobalIndicatorVisibleForAnalysis is false
                // (例如分析開始後，但在renderCurrentPage被調用前，指示器被其他操作隱藏了)
                // 則保持 loadingIndicator.textContent 為 "正在渲染..."，但它應該已經是 block 了
                // 這種情況比較邊緣，目前的邏輯是如果全局分析在跑，指示器應該一直由全局分析控制顯隱和主要文字。
                // --- MODIFICATION END ---
                clearHighlightOverlay(); // 翻頁或重繪時清除舊高亮
                
                // 只有在需要更新聊天記錄時才調用 displayChatMessagesForCurrentPage
                if (updateChatMessages) {
                    displayChatMessagesForCurrentPage(); // 渲染完成后，顯示當前頁面的聊天記錄
                }

                // 應用當前頁面的高亮建議
                if (pageHighlightSuggestions[currentPage] && pageHighlightSuggestions[currentPage].length > 0) {
                    locateAndHighlightText(pageHighlightSuggestions[currentPage]);
                }

            }).catch(error => {
                console.error('渲染 PDF 頁面時發生錯誤:', error);
                loadingIndicator.textContent = '處理 PDF 時發生錯誤';
                // 如果渲染失敗，並且沒有全局分析，則隱藏指示器
                if (!isAnalyzingGlobal) {
                    loadingIndicator.style.display = 'none';
                }
            });
        });
    }
    
    // 清除高亮疊加層
    function clearHighlightOverlay() {
        if (highlightOverlay) {
            const ctx = highlightOverlay.getContext('2d');
            ctx.clearRect(0, 0, highlightOverlay.width, highlightOverlay.height);
        }
    }

    // 在高亮層上繪製矩形 (此函數不再被主動調用，因為定位按鈕已移除)
    function drawHighlightOnOverlay(x, y, width, height) {
        if (!highlightOverlay) return;
        const ctx = highlightOverlay.getContext('2d');
        ctx.fillStyle = "rgba(255, 255, 0, 0.3)"; // 黃色半透明
        ctx.fillRect(x, y, width, height);
    }

    // 嘗試在PDF上定位並高亮文字 (接受一個文字陣列)
    async function locateAndHighlightText(textsToFindArray) {
        if (!pdfDoc || !textsToFindArray || !Array.isArray(textsToFindArray) || textsToFindArray.length === 0) return;
        // clearHighlightOverlay(); // Clearing is now handled by the caller (renderCurrentPage or _appendMessageToChatInterface)

        try {
            const page = await pdfDoc.getPage(currentPage);
            const textContent = await page.getTextContent();
            const viewport = page.getViewport({ scale: currentRenderScale }); // 使用當前渲染的scale

            for (const textToFind of textsToFindArray) {
                if (!textToFind || typeof textToFind !== 'string' || textToFind.trim() === "") continue;

                for (const item of textContent.items) {
                    // A simple check. For more robust matching, consider case-insensitivity or regex.
                    if (item.str.includes(textToFind)) {
                        const tx = item.transform[4];
                        const ty = item.transform[5];
                        
                        const [canvasX, canvasY] = viewport.convertToViewportPoint(tx, ty);
                        
                        // Approximate width and height. This is a simplification.
                        // For precise bounding boxes, PDF text extraction is more complex.
                        const itemWidthInPdfUnits = item.width;
                        // item.height is often the ascent/descent. A more reliable height might be derived from font size or transform[3]
                        const itemHeightInPdfUnits = item.height; 

                        // Transform width and height to viewport scale.
                        // Using item.transform[0] (scaleX) and item.transform[3] (scaleY) from the text item's matrix
                        // combined with the viewport's scale.
                        const approxCanvasWidth = itemWidthInPdfUnits * Math.abs(viewport.scale * (item.transform[0] || 1));
                        // For height, using item.transform[3] (scaleY) is generally more accurate than item.height for scaled text.
                        // If item.transform[3] is 0 or undefined, fallback to a scaled version of item.height or a default.
                        let approxCanvasHeight;
                        if (item.transform[3] && item.transform[3] !== 0) {
                             approxCanvasHeight = Math.abs(item.transform[3]) * viewport.scale;
                        } else {
                             approxCanvasHeight = itemHeightInPdfUnits * viewport.scale * 1.2; // Fallback with a small multiplier
                        }


                        // Adjust Y position. ty is often the baseline.
                        // A common adjustment is to move up by the approximate height.
                        const adjustedCanvasY = canvasY - approxCanvasHeight * 0.8; // Adjust based on typical baseline behavior

                        drawHighlightOnOverlay(canvasX, adjustedCanvasY, approxCanvasWidth, approxCanvasHeight);
                        // Note: If a single `item.str` contains `textToFind` multiple times, this will only highlight the item once.
                        // For multiple highlights within one item, further splitting of `item.str` would be needed.
                    }
                }
            }
        } catch (error) {
            console.error("高亮文字時出錯:", error);
        }
    }

    // --- MODIFICATION START ---
    // 新函數：分析所有頁面並顯示結果，並為每一頁初始化聊天
    async function analyzeAllPagesAndDisplayResults(pageImageParts, pdfName) {
        if (!genAI) {
            addMessage("AI服務未成功初始化，無法分析頁面。", "ai", currentPage); 
            loadingIndicator.style.display = 'none';
            // messageInput.disabled = false; // 這些由調用者處理或在finally中處理
            // sendButton.disabled = false;
            return;
        }

        // --- MODIFICATION START ---
        isAnalyzingGlobal = true;
        // 只對 PDF 內容容器應用霧化效果，而不是整個 pdfViewer
        if(pdfContainer) pdfContainer.classList.add('pdf-view-analyzing');
        messageInput.disabled = true;
        sendButton.disabled = true;
        
        // 確保翻頁按鈕在分析過程中不被禁用
        prevButton.disabled = currentPage === 1; // 只在第一頁時禁用上一頁
        nextButton.disabled = currentPage === totalPages; // 只在最後一頁時禁用下一頁
        
        loadingIndicator.textContent = `開始分析 ${pdfName} 的 ${pageImageParts.length} 個頁面... (0/${pageImageParts.length})`;
        loadingIndicator.style.display = 'block';
        // --- MODIFICATION END ---

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        for (let i = 0; i < pageImageParts.length; i++) {
            const pageNumber = i + 1;
            // --- MODIFICATION START ---
            // 更新全域 loadingIndicator 的文本
            loadingIndicator.textContent = `正在分析 ${pdfName} 第 ${pageNumber} 頁 / 共 ${pageImageParts.length} 頁...`;
            // 移除 tempLoadingMessageElement 的更新邏輯
            // --- MODIFICATION END ---

            const promptForThisPage = `請扮演一位有經驗的輔導老師或學長姐，協助審閱這份高中生學習歷程檔案的第 ${pageNumber} 頁（共 ${pageImageParts.length} 頁）。請提供精簡、具體且有建設性的建議，聚焦於能實際幫助學生改進的關鍵點。請避免過於學術或嚴苛的語氣。您的回覆請盡量簡潔扼要。

請針對此頁面內容與呈現，評估以下方面：
1.  **內容亮點**：此頁面最能吸引人的部分是什麼？（例如：具體的成果、深刻的學習反思、獨特的經驗）
2.  **學習反思**：學生是否有清楚描述從經驗中學到什麼？反思是否深刻且具體？
3.  **個人特質展現**：從內容中可以看出學生的哪些特質？（例如：積極主動、解決問題能力、團隊合作、好奇心）
4.  **與科系連結**（若適用）：內容是否能與學生想申請的科系方向連結？如何能更強化連結？
5.  **美編設計評估**：頁面的排版、色彩搭配、字體選擇、圖像運用等視覺設計是否吸引人且專業？是否有效提升閱讀體驗？
6.  **文字用詞與校對**：文字用詞是否精準恰當？是否有錯別字或標點符號錯誤需要修正？
7.  **整體評分**：綜合考量本頁的內容深度、反思品質、特質展現、科系連結、美編設計以及文字用詞與校對，請給予一個整體評分（滿分10分，可至小數點後一位，例如 7.5 分）。

請按以下格式提供您的回饋（每一項都必須有，若某項無特別建議，可說明「此部分表現良好」或類似）：

【頁碼】: 第 ${pageNumber} 頁
【本頁主題/活動簡述】: (簡要描述此頁呈現的活動、主題或作品)
【內容亮點分析】: (分析此頁的優點或最突出的部分)
【學習反思評估】: (評估反思的深度與具體性，並提供建議)
【個人特質觀察】: (指出展現的個人特質，或建議如何更凸顯)
【科系連結建議】: (針對與科系連結的建議，或肯定已有的連結)
【美編設計評估】: (針對排版、色彩、字體、圖像等視覺設計的具體評價與建議)
【文字用詞與校對建議】: (針對用詞精準度、錯別字、標點符號等提出的具體修正建議)
【整體評分】: (請提供0.0至10.0之間的分數，純數字即可)

請確保您的回饋精煉，避免冗餘說明，直接點出問題和改進方向。您可以使用Markdown格式來增強回應的可讀性。請使用繁體中文回答。`;

            try {
                const result = await model.generateContent([promptForThisPage, pageImageParts[i]]);
                const response = await result.response;
                const feedbackText = response.text();
                console.log(`第 ${pageNumber} 頁分析完成。`);
                
                await initChatSessionForPage(pageNumber, pageImageParts[i], feedbackText);
                addMessage(feedbackText, 'ai', pageNumber); 

            } catch (error) {
                console.error(`分析第 ${pageNumber} 頁時發生錯誤:`, error);
                const errorFeedback = `【頁碼】: 第 ${pageNumber} 頁\n【本頁主題/活動簡述】: 分析此頁面時發生錯誤。\n【內容亮點分析】: 無法提供。\n【學習反思評估】: 無法提供。\n【個人特質觀察】: 無法提供。\n【科系連結建議】: 無法提供。\n【美編設計評估】: 無法提供。\n【文字用詞與校對建議】: 無法提供。\n【整體評分】: 無法提供。\n錯誤訊息：${error.message}`;
                addMessage(errorFeedback, 'ai', pageNumber); 
                pageChatSessions[pageNumber] = null; 
            }
        }

        // --- MODIFICATION START ---
        // 移除聊天框中的臨時loading信息 (因為已經不創建了)
        // if (chatMessages) { 
        //     const messageToRemove = chatMessages.querySelector('.temp-analysis-indicator');
        //     if (messageToRemove) {
        //         chatMessages.removeChild(messageToRemove);
        //     }
        // }
        
        isAnalyzingGlobal = false; // 分析結束
        if(pdfContainer) pdfContainer.classList.remove('pdf-view-analyzing'); // 從 pdfContainer 移除霧化效果
        loadingIndicator.style.display = 'none'; 
        messageInput.disabled = false; 
        sendButton.disabled = false;
        // --- MODIFICATION END ---
    }

    // 新函數：為特定頁面初始化聊天會話
    async function initChatSessionForPage(pageNumber, pageImagePart, analysisText) {
        if (!genAI) {
            console.error(`AI服務未初始化，無法為第 ${pageNumber} 頁建立聊天。`);
            addMessage(`無法為第 ${pageNumber} 頁初始化AI聊天：服務未就緒。`, 'ai-error', pageNumber); 
            pageChatSessions[pageNumber] = null;
            return;
        }

        try {
            const systemMessageText = `您是一位有經驗的學習歷程輔導老師或學長姐。我們正在討論這份學習歷程檔案的第 ${pageNumber} 頁。您已經看過此頁面的圖片和初步分析（包含各項評估與一個整體評分）。請根據這些資訊，以親切且具建設性的方式，回答學生針對「學習歷程」內容提出的問題。您的目標是幫助學生強化其學習反思、展現個人特質、思考與未來申請科系的連結，並優化整體呈現（包含內容、美編設計與表達清晰度）。請避免過於學術的術語，提供具體、可操作的建議。您的所有回答都應該盡可能精簡扼要。您可以使用Markdown格式來增強回應的可讀性，例如使用**粗體**、*斜體*、列表和引用等。請使用繁體中文回答。`;
            
            let initialHistory = [];
            let userParts = [{ text: systemMessageText }, pageImagePart];
            userParts.push({ text: `以下是對第 ${pageNumber} 頁的初步分析，請將其納入考量：\n${analysisText}` });
            
            initialHistory.push({ role: "user", parts: userParts });
            initialHistory.push({ role: "model", parts: [{ text: `我已接收第 ${pageNumber} 頁的圖片及初步分析。請問您想針對這一頁討論什麼？` }] });

            pageChatSessions[pageNumber] = genAI.getGenerativeModel({ 
                model: "gemini-1.5-flash", 
            }).startChat({
                history: initialHistory,
                generationConfig: {
                    temperature: 0.7,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 2048,
                }
            });
            console.log(`第 ${pageNumber} 頁的聊天會話已成功初始化。`);

        } catch (error) {
            console.error(`為第 ${pageNumber} 頁初始化聊天會話失敗:`, error);
            addMessage(`為第 ${pageNumber} 頁初始化AI聊天時發生錯誤: ${error.message}`, 'ai-error', pageNumber); 
            pageChatSessions[pageNumber] = null; // 標記此頁面聊天不可用
        }
    }
    // --- MODIFICATION END ---

    // 初始化聊天會話，建立記憶功能 (此函數不再被直接使用，改用 initChatSessionForPage)
    async function initChatSession(allPageImages = null, perPageAnalyses = null) { 
        // This function is effectively replaced by initChatSessionForPage and the logic in analyzeAllPagesAndDisplayResults
        // It can be removed or heavily refactored if a global fallback chat is ever needed.
        console.warn("Global initChatSession called, but per-page chat sessions are now used. This call might be obsolete or needs to be removed.");
        // Content of the old function is removed to prevent accidental use.
        // If a global chat is ever needed again, this function would need to be re-implemented.
    }
    
    // AI 聊天功能
    
    // 添加消息到聊天窗口
    // --- MODIFICATION START ---
    // 主函數：添加消息到歷史記錄，並更新當前頁面的UI
    function addMessage(text, sender, targetPage = currentPage) {
        if (!pageMessageHistories[targetPage]) {
            pageMessageHistories[targetPage] = [];
        }
        
        // 如果是"思考中..."訊息，不要添加到歷史記錄中
        if (!(sender.includes('thinking') && text === "思考中...")) {
            pageMessageHistories[targetPage].push({ text, sender });
        }

        // 只有當訊息是針對當前正在查看的頁面時，才立即更新UI
        if (targetPage === currentPage) {
            return _appendMessageToChatInterface(text, sender);
        }
        
        return null;
    }

    // 新函數：顯示當前頁面的聊天記錄
    function displayChatMessagesForCurrentPage() {
        if (!chatMessages) return;
        
        // 添加淡出效果
        chatMessages.style.opacity = "0";
        chatMessages.style.transition = "opacity 0.2s ease-out";
        
        setTimeout(() => {
            chatMessages.innerHTML = ''; // 清空現有聊天內容
            
            const history = pageMessageHistories[currentPage];
            if (history) {
                history.forEach(msg => {
                    _appendMessageToChatInterface(msg.text, msg.sender);
                });
            }
            
            // 淡入新內容
            chatMessages.style.opacity = "1";
            
            // 確保滾動到底部
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }, 200);
    }
    
    // 輔助函數：將單個消息渲染到DOM
    function _appendMessageToChatInterface(text, sender) {
        if (chatInterface && chatInterface.classList.contains('hidden')) {
            chatInterface.classList.remove('hidden');
        }

        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message');
        messageDiv.classList.add(sender === 'user' ? 'user-message' : 'ai-message');
        
        // 添加思考中的特殊標識
        if (sender.includes('thinking')) {
            messageDiv.classList.add('thinking-message');
        }
        
        // 先隱藏元素以準備動畫
        messageDiv.style.opacity = "0";
        messageDiv.style.transform = "translateY(10px)";
        
        // 解析AI的結構化回應以美化顯示
        if (sender === 'ai') {
            // 檢查是否需要使用 marked.js 來解析 Markdown
            const markdownSupportAvailable = typeof marked !== 'undefined';
            
            // 新的學習歷程分析格式
            if (text.includes("【本頁主題/活動簡述】:") && text.includes("【內容亮點分析】:")) {
                const extractContent = (tag) => {
                    const regex = new RegExp(`【${tag}】:([\\s\\S]*?)(?=【[\\u4e00-\\u9fa5 /]+(?:建議|評估|觀察|分析|簡述|評分)】:|$)`);
                    const match = text.match(regex);
                    return match && match[1] ? match[1].trim() : null;
                };

                const pageNumText = extractContent("頁碼");
                const topicSummary = extractContent("本頁主題/活動簡述");
                const highlights = extractContent("內容亮點分析");
                const reflectionEval = extractContent("學習反思評估");
                const traitsObservation = extractContent("個人特質觀察");
                const majorConnection = extractContent("科系連結建議");
                const visualDesignEval = extractContent("美編設計評估");
                const wordingProofreadSuggestion = extractContent("文字用詞與校對建議");
                const overallScore = extractContent("整體評分");
                const highlightSuggestionsText = extractContent("關鍵詞句標示建議");
                
                if (pageNumText) { 
                    let htmlContent = ""; 
                    htmlContent += `<div class="suggestion-item"><p><strong>頁碼：</strong>${pageNumText}</p></div>`;
                    
                    // 使用一個輔助函數處理 Markdown 內容
                    const renderWithMarkdown = (content) => {
                        if (!content) return '';
                        return markdownSupportAvailable ? marked.parse(content) : content;
                    };
                    
                    if (topicSummary) {
                        htmlContent += `<div class="suggestion-item"><p><strong>本頁主題/活動簡述：</strong></p>
                                        <div class="markdown-content">${renderWithMarkdown(topicSummary)}</div></div>`;
                    }
                    if (highlights) {
                        htmlContent += `<div class="suggestion-item"><p><strong>內容亮點分析：</strong></p>
                                        <div class="markdown-content">${renderWithMarkdown(highlights)}</div></div>`;
                    }
                    if (reflectionEval) {
                        htmlContent += `<div class="suggestion-item"><p><strong>學習反思評估：</strong></p>
                                        <div class="markdown-content">${renderWithMarkdown(reflectionEval)}</div></div>`;
                    }
                    if (traitsObservation) {
                        htmlContent += `<div class="suggestion-item"><p><strong>個人特質觀察：</strong></p>
                                        <div class="markdown-content">${renderWithMarkdown(traitsObservation)}</div></div>`;
                    }
                    if (majorConnection) {
                        htmlContent += `<div class="suggestion-item"><p><strong>科系連結建議：</strong></p>
                                        <div class="markdown-content">${renderWithMarkdown(majorConnection)}</div></div>`;
                    }
                    if (visualDesignEval) {
                        htmlContent += `<div class="suggestion-item"><p><strong>美編設計評估：</strong></p>
                                        <div class="markdown-content">${renderWithMarkdown(visualDesignEval)}</div></div>`;
                    }
                    if (wordingProofreadSuggestion) {
                        htmlContent += `<div class="suggestion-item"><p><strong>文字用詞與校對建議：</strong></p>
                                        <div class="markdown-content">${renderWithMarkdown(wordingProofreadSuggestion)}</div></div>`;
                    }
                    if (overallScore) {
                        htmlContent += `<div class="suggestion-item"><p><strong>整體評分：</strong>${overallScore} / 10.0</p></div>`;
                    }

                    if (highlightSuggestionsText && highlightSuggestionsText !== "無特別建議標示的詞句") {
                        const suggestionsArray = highlightSuggestionsText.split('\n').map(s => s.trim()).filter(s => s.length > 0);
                        if (suggestionsArray.length > 0) {
                            const pageNumForSuggestions = parseInt(pageNumText.match(/\d+/)[0]);
                            pageHighlightSuggestions[pageNumForSuggestions] = suggestionsArray; // 儲存高亮建議
                            
                            htmlContent += `<div class="suggestion-item"><p><strong>建議標示重點：</strong></p><ul class="markdown-content">`;
                            suggestionsArray.forEach(suggestion => {
                                htmlContent += `<li>${renderWithMarkdown(suggestion)}</li>`;
                            });
                            htmlContent += `</ul></div>`;

                            // 如果是當前頁面，立即嘗試高亮
                            if (pageNumForSuggestions === currentPage) {
                                clearHighlightOverlay(); // 清除舊的，避免疊加
                                locateAndHighlightText(suggestionsArray);
                            }
                        }
                    }
                    
                    // 添加免責聲明
                    htmlContent += `<p style="font-size: 0.8em; color: #777; margin-top: 15px; padding-top: 10px; border-top: 1px solid #eee;"><strong>溫馨提醒：</strong>以上AI建議與評分僅供參考。</p>`;
                    
                    messageDiv.innerHTML = htmlContent;
                } else if (markdownSupportAvailable) {
                    // 如果是一般回應但有 marked.js 可用，則解析 Markdown
                    messageDiv.innerHTML = marked.parse(text);
                } else {
                    messageDiv.textContent = text; // 如果無法解析，顯示原始文本
                }
            }
            // 保留舊的學術分析格式處理邏輯，但增加 Markdown 支援
            else if (text.includes("【文字內容概述】:") && text.includes("【學術評價】:")) {
                const extractContent = (tag) => {
                    const regex = new RegExp(`【${tag}】:([\\s\\S]*?)(?=【[\\u4e00-\\u9fa5]+】:|$)`);
                    const match = text.match(regex);
                    return match && match[1] ? match[1].trim() : null;
                };

                const pageNumText = extractContent("頁碼");
                const contentSummary = extractContent("文字內容概述");
                const academicEval = extractContent("學術評價");
                const suggestions = extractContent("修改建議");
                const referenceEval = extractContent("參考文獻評價");
                
                if (pageNumText && (contentSummary || academicEval || suggestions || referenceEval)) { 
                    let htmlContent = ""; 
                    htmlContent += `<div class="suggestion-item"><p><strong>頁碼：</strong>${pageNumText}</p></div>`;
                    if (contentSummary) {
                        htmlContent += `<div class="suggestion-item"><p><strong>文字內容概述：</strong>${contentSummary}</p></div>`;
                    }
                    if (academicEval) {
                        htmlContent += `<div class="suggestion-item"><p><strong>學術評價：</strong>${academicEval}</p></div>`;
                    }
                    if (suggestions) {
                        htmlContent += `<div class="suggestion-item"><p><strong>修改建議：</strong>${suggestions}</p></div>`;
                    }
                    if (referenceEval) {
                        htmlContent += `<div class="suggestion-item"><p><strong>參考文獻評價：</strong>${referenceEval}</p></div>`;
                    }
                    messageDiv.innerHTML = htmlContent;
                } else {
                    messageDiv.textContent = text;
                }
            }
            // 保留更早的格式處理邏輯，但增加 Markdown 支援
            else if (text.includes("【原始內容描述】:") && text.includes("【修改建議】:")) {
                const extractContent = (tag) => {
                    const regex = new RegExp(`【${tag}】:([\\s\\S]*?)(?=【[\\u4e00-\\u9fa5]+內容描述】:|【[\\u4e00-\\u9fa5]+建議】:|【[\\u4e00-\\u9fa5]+外觀/效果描述】:|【頁碼】:|$)`);
                    const match = text.match(regex);
                    return match && match[1] ? match[1].trim() : null;
                };

                const pageNumText = extractContent("頁碼");
                const originalDesc = extractContent("原始內容描述");
                const suggestion = extractContent("修改建議");
                const afterEffect = extractContent("修改後外觀/效果描述");
                
                const introTextMatch = text.match(/^([\s\S]*?)(?=【頁碼】:|【原始內容描述】:)/);
                let introText = "";
                if (introTextMatch && introTextMatch[1] && introTextMatch[1].trim().length > 0) {
                    if (!introTextMatch[1].includes("【頁碼】") && 
                        !introTextMatch[1].includes("【原始內容描述】") &&
                        !introTextMatch[1].includes("【修改建議】") &&
                        !introTextMatch[1].includes("【修改後外觀/效果描述】")) {
                        introText = `<p>${introTextMatch[1].trim()}</p>`;
                    }
                }

                if (pageNumText && (originalDesc || suggestion)) { 
                    let htmlContent = introText; 
                    htmlContent += `<div class="suggestion-item"><p><strong>頁碼：</strong>${pageNumText}</p></div>`;
                    if (originalDesc) {
                        htmlContent += `<div class="suggestion-item"><p><strong>原始內容/區域：</strong>${originalDesc}</p></div>`;
                    }
                    if (suggestion) {
                        htmlContent += `<div class="suggestion-item"><p><strong>修改建議：</strong>${suggestion}</p></div>`;
                    }
                    if (afterEffect) {
                        htmlContent += `<div class="suggestion-item"><p><strong>修改後效果：</strong>${afterEffect}</p></div>`;
                    }
                    messageDiv.innerHTML = htmlContent;
                } else {
                    messageDiv.textContent = text;
                }
            } else {
                // 對於不符合特定格式的一般回應，如果有 marked.js 可用，則解析 Markdown
                if (markdownSupportAvailable) {
                    messageDiv.innerHTML = marked.parse(text);
                } else {
                    messageDiv.textContent = text;
                }
            }
        } else {
            // 用戶訊息不解析 Markdown
            messageDiv.textContent = text;
        }
        
        chatMessages.appendChild(messageDiv);
        
        // 使用 requestAnimationFrame 來確保 DOM 更新後再添加過渡效果
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                messageDiv.style.transition = "opacity 0.3s ease, transform 0.3s ease";
                messageDiv.style.opacity = "1";
                messageDiv.style.transform = "translateY(0)";
            });
        });
        
        chatMessages.scrollTop = chatMessages.scrollHeight;
    
    }
    // --- MODIFICATION END ---
    
    // 處理發送消息
    function handleSendMessage() {
        const message = messageInput.value.trim();
        if (message === '') return;
        
        // 添加用戶消息
        addMessage(message, 'user', currentPage); 
        messageInput.value = '';
        
        // 使用Gemini AI處理
        processWithGemini(message);
    }
    
    // 發送按鈕點擊事件，添加視覺反饋
    sendButton.addEventListener('click', function() {
        // 添加點擊效果
        this.classList.add('send-active');
        setTimeout(() => this.classList.remove('send-active'), 150);
        
        handleSendMessage();
    });
    
    // 消息輸入框焦點效果
    messageInput.addEventListener('focus', function() {
        this.parentElement.classList.add('input-focused');
    });
    
    messageInput.addEventListener('blur', function() {
        this.parentElement.classList.remove('input-focused');
    });
    
    // 按Enter鍵發送
    messageInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            handleSendMessage();
        }
    });
    
    // 使用Gemini API處理消息（帶記憶功能）
    async function processWithGemini(userMessage) {
        const currentChat = pageChatSessions[currentPage];

        if (!currentChat) { 
            addMessage(`AI聊天功能尚未為第 ${currentPage} 頁準備就緒，或初始化失敗。請確保該頁面分析已完成。`, "ai-error", currentPage); 
            console.warn(`嘗試在第 ${currentPage} 頁聊天會話未初始化時發送消息。`);
            return;
        }
        
        // 添加思考中訊息，並為其添加特殊類別
        const thinkingMessage = addMessage("思考中...", 'ai thinking-message', currentPage); 
        
        try {
            console.log(`發送訊息到第 ${currentPage} 頁的聊天會話:`, userMessage);
            
            const result = await currentChat.sendMessage(userMessage);
            const response = await result.response;
            const aiResponse = response.text();
            
            console.log("AI回應成功:", aiResponse);
            
            // 刪除"思考中..."訊息
            removeThinkingMessage();
            
            // 添加 AI 的實際回應
            addMessage(aiResponse, 'ai', currentPage); 
            
        } catch (error) {
            console.error('Gemini API處理失敗:', error);
            
            // 刪除"思考中..."訊息
            removeThinkingMessage();
            
            // 回退模式 (簡化：不嘗試重新發送圖片，只提示錯誤)
            let errorMessage = "抱歉，與AI服務通信時出現問題。";
            if (error.message.includes("API key not valid")) {
                errorMessage = "API金鑰無效或過期，請檢查您的API金鑰設定。";
            } else if (error.message.includes("quota")) {
                errorMessage = "已超過API請求配額，請稍後再試。";
            } else if (error.message.includes("400")) {
                 errorMessage = "請求格式錯誤或內容不被AI服務接受。可能是圖片過大或格式問題。";
            } else if (error.message.toLowerCase().includes("model not found")) {
                errorMessage = "指定的AI模型不存在，請檢查模型名稱設定。";
            } else if (error.message.toLowerCase().includes("permission denied") || error.message.toLowerCase().includes("failed to fetch")) {
                errorMessage = "網路連線或權限問題導致無法連接AI服務，請檢查您的網路和API金鑰權限。";
            }

            addMessage(errorMessage, 'ai', currentPage); 
        }
    }
    
    // 新增一個函數來移除思考中訊息
    function removeThinkingMessage() {
        if (chatMessages) {
            const thinkingMessages = chatMessages.querySelectorAll('.thinking-message');
            thinkingMessages.forEach(msg => {
                if (msg.parentNode) {
                    msg.parentNode.removeChild(msg);
                }
            });
        }
    }

    // 添加鍵盤快捷鍵支持
    document.addEventListener('keydown', function(e) {
        if (!pdfDoc) return; // 如果沒有加載 PDF 則不處理
        
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            if (currentPage > 1 && !messageInput.matches(':focus')) {
                currentPage--;
                renderCurrentPage();
            }
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            if (currentPage < totalPages && !messageInput.matches(':focus')) {
                currentPage++;
                renderCurrentPage();
            }
        }
    });
    
    // PDF 縮放事件監聽
    zoomInButton.addEventListener('click', function() {
        if (pdfDoc && currentRenderScale < maxScale) {
            currentRenderScale += scaleStep;
            renderCurrentPage(false); // 縮放時不需要更新聊天記錄
        }
    });

    zoomOutButton.addEventListener('click', function() {
        if (pdfDoc && currentRenderScale > minScale) {
            currentRenderScale -= scaleStep;
            // 確保不會小於 minScale
            currentRenderScale = Math.max(minScale, currentRenderScale);
            renderCurrentPage(false); // 縮放時不需要更新聊天記錄
        }
    });

    zoomResetButton.addEventListener('click', async function() {
        if (pdfDoc) {
            currentRenderScale = await calculateInitialScale(); // 重設為適合容器的初始大小
            renderCurrentPage(false); // 縮放時不需要更新聊天記錄
        }
    });

    // 調整窗口大小時重新渲染當前頁面以適應新的容器大小
    window.addEventListener('resize', async function() { // 改為 async
        if (pdfDoc) {
            currentRenderScale = await calculateInitialScale(); // 窗口大小改變時重新計算初始縮放
            renderCurrentPage(false); // 調整窗口大小時不需要更新聊天記錄
        }
    });

    // 添加 Ctrl + 滾輪縮放功能
    pdfContainer.addEventListener('wheel', function(e) {
        // 檢查是否按住 Ctrl 鍵
        if (e.ctrlKey && pdfDoc) {
            // 阻止默認滾動行為
            e.preventDefault();
            
            // 根據滾輪方向確定是放大還是縮小
            // deltaY < 0 表示向上滾動 (放大)
            // deltaY > 0 表示向下滾動 (縮小)
            const zoomFactor = e.deltaY < 0 ? scaleStep : -scaleStep;
            
            // 調整縮放比例
            currentRenderScale += zoomFactor;
            
            // 確保縮放比例在允許範圍內
            currentRenderScale = Math.max(minScale, Math.min(maxScale, currentRenderScale));
            
            // 重新渲染頁面，但不更新聊天記錄
            renderCurrentPage(false);
        }
    }, { passive: false }); // passive: false 允許阻止默認行為

    // PDF 拖曳平移功能
    let isDraggingPdf = false;
    let pdfDragPageX, pdfDragPageY;
    let pdfScrollLeftStart, pdfScrollTopStart;

    if (pdfContainer) {
        pdfContainer.style.overflow = 'auto'; // 確保容器可滾動
        pdfContainer.style.cursor = 'grab'; // 初始鼠標樣式
        // 新增：確保放大後內容左上角對齊，方便拖曳查看所有區域
        pdfContainer.style.display = 'flex';
        pdfContainer.style.justifyContent = 'flex-start';
        pdfContainer.style.alignItems = 'flex-start';


        pdfContainer.addEventListener('mousedown', (e) => {
            // 僅當左鍵按下且 PDF 已載入時觸發
            if (e.button !== 0 || !pdfDoc) return;

            isDraggingPdf = true;
            pdfContainer.style.cursor = 'grabbing'; // 拖曳時的鼠標樣式
            
            pdfDragPageX = e.pageX; // 記錄滑鼠在文件中的初始 X 位置
            pdfDragPageY = e.pageY; // 記錄滑鼠在文件中的初始 Y 位置
            
            pdfScrollLeftStart = pdfContainer.scrollLeft; // 記錄 pdfContainer 的初始滾動 X 位置
            pdfScrollTopStart = pdfContainer.scrollTop; // 記錄 pdfContainer 的初始滾動 Y 位置
            
            e.preventDefault(); // 防止文字選取等預設行為
        });

        // 在整個文件上監聽 mousemove，以便在滑鼠移出 pdfContainer 時仍能拖曳
        document.addEventListener('mousemove', (e) => {
            if (!isDraggingPdf || !pdfDoc) return;

            const dx = e.pageX - pdfDragPageX; // 計算滑鼠 X 方向的移動距離
            const dy = e.pageY - pdfDragPageY; // 計算滑鼠 Y 方向的移動距離

            // 更新 pdfContainer 的滾動位置
            pdfContainer.scrollLeft = pdfScrollLeftStart - dx;
            pdfContainer.scrollTop = pdfScrollTopStart - dy;
        });

        // 在整個文件上監聽 mouseup，以確保釋放滑鼠按鍵時停止拖曳
        document.addEventListener('mouseup', (e) => {
            // 僅當釋放的是左鍵且正在拖曱 PDF 時
            if (e.button === 0 && isDraggingPdf && pdfDoc) {
                isDraggingPdf = false;
                pdfContainer.style.cursor = 'grab'; // 恢復鼠標樣式
            }
        });
        
        // 可選：如果滑鼠在拖曳時離開 pdfContainer，也停止拖曱
        // pdfContainer.addEventListener('mouseleave', () => {
        //     if (isDraggingPdf && pdfDoc) {
        //         isDraggingPdf = false;
        //         pdfContainer.style.cursor = 'grab';
        //     }
        // });
    }

    // 初始隱藏聊天框
    if (chatInterface) {
        chatInterface.classList.add('hidden');
    }
});
