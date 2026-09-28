using EduMaster.Web;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using EduMaster.Core;
using EduMaster.App;
using Microsoft.AspNetCore.Http.Features;

var builder=WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();builder.Logging.AddConsole();
builder.Logging.AddFilter("Microsoft.AspNetCore",LogLevel.Warning);
builder.WebHost.ConfigureKestrel(o=>o.Limits.MaxRequestBodySize=FileImport.MaxBytes*2L+256*1024);
builder.Services.Configure<FormOptions>(o=>o.MultipartBodyLengthLimit=FileImport.MaxBytes*2L+256*1024);
var app=builder.Build();app.Urls.Add(Environment.GetEnvironmentVariable("EDUMASTER_LISTEN_URL")?.Trim() is {Length:>0} listenUrl?listenUrl:"http://127.0.0.1:18280");
var configPath=Path.Combine(app.Environment.ContentRootPath,"access-token.txt");
if(!File.Exists(configPath))File.WriteAllText(configPath,Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(8)));
string GetAccess()=>File.Exists(configPath)?File.ReadAllText(configPath).Trim():"";
var jobRegistry=new GenerationJobRegistry();var jobs=jobRegistry.Jobs;var gate=jobRegistry.Gate;var importGate=new SemaphoreSlim(2);
var completedImports=new ConcurrentDictionary<string,(DateTime Created,IResult Response)>();
var resultCache=new GenerationResultCache(Path.Combine(app.Environment.ContentRootPath,"job-cache"));
var learningArchive=new LearningArchive(Path.Combine(app.Environment.ContentRootPath,"learning-archive"));
var generationGuidance=new GenerationGuidanceStore(Path.Combine(app.Environment.ContentRootPath,"learning-archive","settings"));
foreach(var saved in resultCache.Load(DateTime.UtcNow)){
    foreach(var output in saved.Value.Outputs)if(output.Result is not null){var partial=output.StageNumber>0&&output.StageNumber<output.StageCount;var restored=LearningStagePlan.RepairExposedConclusion(output.Result,output.Result.LearningSteps.Length>0?output.Result.LearningSteps:output.Result.SourceSteps,partial);restored=restored with{Explanation=VariantResponse.RestoreFullStepOutline(restored.Explanation,restored.Steps)};var quality=partial?ProblemQualityHarness.RefreshPartialStage(restored):ProblemQualityHarness.RefreshCompleted(restored);output.Result=restored with{QualityJobId=saved.Key,Quality=quality};}
    saved.Value.Result=saved.Value.Outputs.FirstOrDefault(o=>o.State=="ready")?.Result;
    saved.Value.InvalidateFailedCachedSet();
    jobs[saved.Key]=saved.Value;
    if(saved.Value.State=="ready")try{learningArchive.StageAsync(saved.Key,saved.Value).GetAwaiter().GetResult();}
    catch(Exception e)when(e is IOException or JsonException or UnauthorizedAccessException){app.Logger.LogWarning("Learning staging failed: job={JobId}, exceptionType={ExceptionType}",saved.Key,e.GetType().Name);}
}
var usageLedger=new DeepSeekUsageHandler(Path.Combine(app.Environment.ContentRootPath,"api-usage"),new HttpClientHandler{AllowAutoRedirect=false},disablePaidCalls:Environment.GetEnvironmentVariable("EDUMASTER_NO_PAID_CALLS")=="1");
using var client=new HttpClient(usageLedger){Timeout=TimeSpan.FromSeconds(480)};
var generator=new LocalGemmaGenerator(client);
var deepseek=new DeepSeekVisualGenerator(client);
var deepseekAccount=new DeepSeekAccountClient(client);
var problemSolver=new ProblemSolver(client);
var qualityReviewer=new QualityReviewClient(client);
var deepseekKeyPath=Path.Combine(app.Environment.ContentRootPath,"deepseek-api-key.txt");
var deepseekKey=File.Exists(deepseekKeyPath)?File.ReadAllText(deepseekKeyPath).Trim():"";
var sourceCache=new ImageSourceCache(Path.Combine(app.Environment.ContentRootPath,"source-cache"));
var sources=new ConcurrentDictionary<string,ImageSource>(sourceCache.Load(DateTime.UtcNow));
var reportArchive=new ReportArchive(Path.Combine(app.Environment.ContentRootPath,"reports"),Path.Combine(app.Environment.WebRootPath,"style.css"));
app.Use(async(context,next)=>{
    using var callScope=usageLedger.BeginScope(context.TraceIdentifier,context.Request.Path.ToString(),context.Request.Path=="/api/generate"?18:6);
    context.Response.Headers.CacheControl="no-store";context.Response.Headers["Referrer-Policy"]="no-referrer";
    context.Response.Headers["X-Content-Type-Options"]="nosniff";
    context.Response.Headers["Content-Security-Policy"]="default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    if(context.Request.Path.StartsWithSegments("/api")){
        var supplied=context.Request.Headers.Authorization.ToString();var expected="Bearer "+GetAccess();
        var authorized=CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied),Encoding.UTF8.GetBytes(expected));
        if(!authorized){context.Response.StatusCode=401;await context.Response.WriteAsJsonAsync(new{error="비밀번호가 올바르지 않습니다."});return;}
    }
    try{await next(context);}catch(DeepSeekAccountException e){
        if(!context.Response.HasStarted){context.Response.StatusCode=402;await context.Response.WriteAsJsonAsync(new{error=e.Message});}
    }catch(Exception e) when(e is ArgumentException or InvalidDataException or InvalidOperationException or TimeoutException or IOException or System.Runtime.InteropServices.COMException or System.Xml.XmlException or BadHttpRequestException){
        app.Logger.LogWarning(e,"Request failed: {Path}",context.Request.Path);
        if(!context.Response.HasStarted){context.Response.StatusCode=400;await context.Response.WriteAsJsonAsync(new{error=e is BadHttpRequestException?"파일은 10MB까지 지원합니다.":e.Message});}
    }catch(OperationCanceledException){if(!context.Response.HasStarted){context.Response.StatusCode=context.RequestAborted.IsCancellationRequested?499:408;if(!context.RequestAborted.IsCancellationRequested)await context.Response.WriteAsJsonAsync(new{error="이미지 분석 서버의 전체 처리 시간이 초과됐습니다. 파일은 정상일 수 있으며 잠시 후 같은 파일로 다시 분석해 주세요."});}}
    catch(Exception){if(!context.Response.HasStarted){context.Response.StatusCode=500;await context.Response.WriteAsJsonAsync(new{error="처리하지 못했습니다. 입력은 유지됩니다. 파일과 서버 상태를 확인해 주세요."});}}
});
app.UseDefaultFiles();app.UseStaticFiles();
app.MapGet("/api/usage",(string? scope)=>Results.Ok(new{calls=scope is null?usageLedger.Read():usageLedger.Read().Where(r=>r.Scope==scope).ToArray()}));
app.MapGet("/result",()=>Results.Redirect("./"));
app.MapGet("/learning",()=>Results.Redirect("./learning/"));
app.MapGet("/api/status",async(CancellationToken token)=>{
    LocalModel? gemmaModel=null;
    try{using var timeout=CancellationTokenSource.CreateLinkedTokenSource(token);timeout.CancelAfter(TimeSpan.FromSeconds(3));gemmaModel=await generator.ProbeAsync(LocalGemmaGenerator.ConfiguredEndpoint,timeout.Token,requireVision:true);}catch(Exception) when(!token.IsCancellationRequested){}
    var deepseekConfigured=deepseekKey.Length>0;
    return Results.Ok(new{ready=deepseekConfigured||gemmaModel is not null,activeGenerations=jobs.Values.Count(j=>!j.Finished),vision=true,model=deepseekConfigured?DeepSeekVisualGenerator.DisplayName:gemmaModel?.Name??"모델 연결 없음",deepseekConfigured,deepseekModel=DeepSeekVisualGenerator.DisplayName,gemmaAvailable=gemmaModel is not null,gemmaModel=gemmaModel?.Name??"Gemma 4 12B",gemmaAvailabilityText=gemmaModel is not null?"현재 PC 연결됨":"현재 PC가 켜져 있을 때만 사용 가능",context=gemmaModel?.ContextSize,version="0.7.0-linux-backend",publicTest=false});
});
app.MapGet("/api/sources/{id}",(string id,bool? preview)=>sources.TryGetValue(id,out var source)&&DateTime.UtcNow-source.Created<TimeSpan.FromHours(2)
    ?Results.Ok(new{ready=true,expiresAt=source.Created.AddHours(2),pageCount=source.Pages.Length,previewDataUrl=preview==true?source.Pages[0].DataUrl:null,previewDataUrls=preview==true?source.Pages.Select(p=>p.DataUrl).ToArray():null,previewMaterialRoles=preview==true?source.Pages.Select(p=>p.MaterialRole).ToArray():null}) :Results.Ok(new{ready=false}));
app.MapPost("/api/import",async(HttpRequest request,CancellationToken requestToken)=>{
    using var deadline=CancellationTokenSource.CreateLinkedTokenSource(requestToken);deadline.CancelAfter(TimeSpan.FromSeconds(210));var token=deadline.Token;var gateAcquired=false;
    try{
    if(!await importGate.WaitAsync(TimeSpan.FromSeconds(15),token))throw new InvalidOperationException("다른 이미지 분석이 진행 중입니다. 파일은 유지되며 잠시 후 같은 단계에서 다시 분석해 주세요.");gateAcquired=true;
    if(!request.HasFormContentType)throw new ArgumentException("파일을 선택해 주세요.");
    var form=await request.ReadFormAsync(token);var readingProvider=form["provider"].ToString();var materialKind=form["materialKind"].ToString();var importRequestId=form["requestId"].ToString();
    if(importRequestId.Length>0&&!System.Text.RegularExpressions.Regex.IsMatch(importRequestId,"^[a-f0-9]{32}$"))throw new ArgumentException("이미지 분석 요청 번호 형식이 올바르지 않습니다.");
    if(importRequestId.Length>0&&completedImports.TryGetValue(importRequestId,out var completed)&&DateTime.UtcNow-completed.Created<TimeSpan.FromHours(2))return completed.Response;
    var combined=materialKind=="problem-solution";var separate=materialKind=="problem-solution-separate";var problemOnly=materialKind=="problem-only";
    if(!combined&&!separate&&!problemOnly)throw new ArgumentException("문제와 풀이 입력 방식을 확인해 주세요.");
    if(readingProvider!=""&&readingProvider is not("gemma" or "deepseek" or "both"))throw new ArgumentException("생성 모델을 선택해 주세요.");
    var cloudReading=readingProvider is "deepseek" or "both";
    if(cloudReading)await deepseekAccount.EnsureAvailableAsync(deepseekKey,token);
    var file=combined?form.Files.GetFile("file")??throw new ArgumentException("문제와 풀이가 함께 있는 이미지를 선택해 주세요."):null;
    var questionFile=separate||problemOnly?form.Files.GetFile("questionFile")??throw new ArgumentException("문제 이미지를 선택해 주세요."):null;
    var solutionFile=separate?form.Files.GetFile("solutionFile")??throw new ArgumentException("풀이 이미지를 선택해 주세요."):null;
    foreach(var upload in new[]{file,questionFile,solutionFile}.Where(f=>f is not null))if(upload!.Length is <=0 or >FileImport.MaxBytes)throw new ArgumentException("각 파일은 비어 있지 않은 10MB 이하 자료여야 합니다.");
    var directory=Path.Combine(app.Environment.ContentRootPath,"uploads",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
    try{
        async Task<(ProblemDraft Draft,VisualPage[] Pages)> Load(IFormFile upload,string stem,bool imageOnly){
            var extension=Path.GetExtension(upload.FileName).ToLowerInvariant();
            if(extension is not(".txt" or ".docx" or ".png" or ".jpg" or ".jpeg" or ".pdf")||imageOnly&&extension is (".txt" or ".docx"))throw new ArgumentException(imageOnly?"문제와 풀이 파일은 PNG·JPG·한 페이지 PDF를 사용해 주세요.":"PDF·PNG·JPG·TXT·DOCX를 지원합니다.");
            var path=Path.Combine(directory,stem+extension);await using(var output=File.Create(path))await upload.CopyToAsync(output,token);
            var imported=await FileImport.ImportAsync(path,directory,token);var rendered=imported.Source!.IsAttachment?await LocalDocumentReader.RenderAsync(imported.Source,directory,token):[];return(imported,rendered);
        }
        var first=await Load(file??questionFile!,"question",separate||problemOnly);var body=first.Draft.Body;var pages=first.Pages;string? sourceId=null;ProblemSolutionMaterial? material=null;string? materialReaderName=null;
        if(first.Draft.Source!.IsAttachment){
            var reader=new LocalVisionReader(client);VisualPage[] views;
            if(separate){
                var second=await Load(solutionFile!,"solution",true);
                if(pages.Length!=1||second.Pages.Length!=1)throw new ArgumentException("문제 파일과 풀이 파일은 각각 이미지 한 장 또는 한 페이지 PDF로 넣어 주세요.");
                pages=[pages[0] with{Page=1,MaterialRole="question"},second.Pages[0] with{Page=2,MaterialRole="solution"}];
                async Task<VisualPage[]> RoleViews(VisualPage page){
                    var regions=await LocalDocumentReader.MaterialViewsAsync(page,token);
                    var selected=regions.Any(r=>r.MaterialRole==page.MaterialRole)?regions.Where(r=>r.MaterialRole==page.MaterialRole):regions;
                    return selected.Select(r=>r with{MaterialRole=page.MaterialRole}).ToArray();
                }
                var questionViews=await RoleViews(pages[0]);var solutionViews=await RoleViews(pages[1]);
                views=await LocalDocumentReader.ReadableMaterialViewsAsync(questionViews.Concat(solutionViews).ToArray(),token);
            }else if(combined){
                if(pages.Length!=1)throw new ArgumentException("한 장 입력은 문제와 풀이가 함께 보이는 이미지 한 장 또는 한 페이지 PDF를 사용해 주세요.");
                views=await LocalDocumentReader.ReadableMaterialViewsAsync(await LocalDocumentReader.MaterialViewsAsync(pages[0],token),token);
            }else{
                if(pages.Length!=1)throw new ArgumentException("문제 파일은 이미지 한 장 또는 한 페이지 PDF로 넣어 주세요.");
                pages=[pages[0] with{Page=1,MaterialRole="question"}];views=pages;
            }
            async Task<(ProblemSolutionMaterial Material,bool Retried)> ReadDeepSeekMaterial(){
                try{return(await deepseek.ReadMaterialAsync(pages[0],deepseekKey,token,views,isolateRegions:true),false);}
                catch(InvalidDataException){return(await deepseek.ReadMaterialAsync(pages[0],deepseekKey,token,views,recoverTruncated:true,isolateRegions:true),true);}
            }
            if(problemOnly){
                body=cloudReading?await deepseek.ReadAsync(pages[0],deepseekKey,token):await reader.ReadAsync(pages[0].Bytes,pages[0].MimeType,token);
                body=ReactionMassCheck.NormalizeSupportedOcr(body);
            }else{
                if(cloudReading){var read=await ReadDeepSeekMaterial();material=read.Material;if(read.Retried)material=material with{Uncertainties=material.Uncertainties.Concat(["첫 이미지 분석 응답의 형식을 읽지 못해 서버가 자동으로 한 번 더 분석했습니다."]).Distinct().ToArray()};materialReaderName=DeepSeekVisualGenerator.DisplayName;}
                else{
                    var model=await generator.ProbeAsync(LocalGemmaGenerator.ConfiguredEndpoint,token,true);
                    try{material=await reader.ReadMaterialAsync(pages[0],token,LocalGemmaGenerator.ConfiguredEndpoint,model.Id,views);materialReaderName="로컬 Gemma 4 12B";}
                    catch(Exception e) when(deepseekKey.Length>0&&e is InvalidDataException or TimeoutException or InvalidOperationException){
                        var read=await ReadDeepSeekMaterial();material=read.Material;
                        material=material with{Uncertainties=material.Uncertainties.Concat(["Gemma가 표 또는 STEP 구조를 안정적으로 읽지 못해 DeepSeek 이미지 분석으로 자동 보정했습니다. 생성 모델 선택은 변경하지 않았습니다."]).Concat(read.Retried?["DeepSeek의 첫 응답 형식도 읽지 못해 서버가 자동으로 한 번 더 분석했습니다."]:[]).Distinct().ToArray()};
                        materialReaderName=DeepSeekVisualGenerator.DisplayName+" 자동 보정";
                    }
                }
                try{material=material.WithVerifiedLogic();}
                catch(InvalidDataException e)when(e.Data.Contains("TeacherMethodReread")&&deepseekKey.Length>0){
                    material=await deepseek.ReadMaterialAsync(pages[0],deepseekKey,token,views,rereadReason:e.Message,isolateRegions:true);
                    material=material.WithVerifiedLogic();
                    material=material with{Uncertainties=material.Uncertainties.Concat(["풀이 판독과 독립 검산의 충돌 영역을 원본 이미지에서 한 번 더 읽었습니다. 코드 풀이로 교체하지 않았습니다."]).Distinct().ToArray()};
                    materialReaderName=DeepSeekVisualGenerator.DisplayName+" 원본 재판독";
                }
                material=TeacherMethodPolicy.EnrichReadSteps(material);
                body=material.Body;
            }
            foreach(var old in sources.Where(x=>DateTime.UtcNow-x.Value.Created>TimeSpan.FromHours(2)).ToArray()){sources.TryRemove(old.Key,out _);sourceCache.Remove(old.Key);}
            if(sources.Count>=10)throw new InvalidOperationException("이미지 보관 작업이 많습니다. 잠시 후 다시 넣어 주세요.");
            sourceId=Guid.NewGuid().ToString("N");var storedSource=new ImageSource(pages,DateTime.UtcNow);await sourceCache.SaveAsync(sourceId,storedSource,token);sources[sourceId]=storedSource;
        }
        var displayName=separate?Path.GetFileName(questionFile!.FileName)+" + "+Path.GetFileName(solutionFile!.FileName):Path.GetFileName((file??questionFile)!.FileName);
        IResult response=Results.Ok(new{title=Path.GetFileNameWithoutExtension(Path.GetFileName((file??questionFile!).FileName)),body,answer=material?.Answer??"",explanation=material?.Explanation??"",steps=material?.Steps??[],uncertainties=material?.Uncertainties??[],materialKind=problemOnly?"problem-only":"problem-solution-separate",sourceId,sourceExpiresAt=sourceId is null?(DateTime?)null:sources[sourceId].Created.AddHours(2),fileName=displayName,readMethod=material is not null?materialReaderName+(material.UsedCodeRepair?" 이미지 판독 + 코드 풀이 보정":" 문제·풀이 분리"):first.Draft.Source.IsAttachment?(cloudReading?DeepSeekVisualGenerator.DisplayName+" 원본 이미지 인식":LocalVisionReader.ReadMethod):"본문 추출",needsReview=first.Draft.Source.IsAttachment,previewDataUrl=pages.Length>0?pages[0].DataUrl:null,previewDataUrls=pages.Select(p=>p.DataUrl).ToArray(),previewMaterialRoles=pages.Select(p=>p.MaterialRole).ToArray()});
        foreach(var old in completedImports.Where(item=>DateTime.UtcNow-item.Value.Created>TimeSpan.FromHours(2)).ToArray())completedImports.TryRemove(old.Key,out _);
        if(importRequestId.Length>0)completedImports[importRequestId]=(DateTime.UtcNow,response);
        return response;
    }finally{Directory.Delete(directory,true);}
    }finally{if(gateAcquired)importGate.Release();}
});
app.MapPost("/api/reports",async(ReportSaveInput input,HttpContext context)=>{
    var saved=await reportArchive.SaveAsync(input.Title,input.Html,context.RequestAborted);
    return Results.Ok(new{saved.Id,saved.Title,saved.CreatedAt,saved.Size});
});
app.MapGet("/api/reports/{id}/file",(string id,bool? download)=>download==true&&reportArchive.GetPdfPath(id) is { } path
    ?Results.File(path,"application/pdf",Path.GetFileNameWithoutExtension(path)+".pdf",enableRangeProcessing:true)
    :Results.NotFound(new{error="PDF 보기 목록은 제공하지 않습니다. 생성 직후 PDF 저장 버튼으로 내려받아 주세요."}));
app.MapGet("/api/learning/problems",()=>Results.Ok(learningArchive.List()));
app.MapGet("/api/learning/jobs/{id}/status",(string id)=>Results.Ok(new{added=learningArchive.HasJob(id),pdfSaved=learningArchive.GetPdfReportId(id) is { } pdfId && reportArchive.GetPdfPath(pdfId) is not null}));
app.MapGet("/api/learning/jobs/{id}/pdf",(string id)=>learningArchive.GetPdfReportId(id) is { } pdfId && reportArchive.GetPdfPath(pdfId) is { } path
    ?Results.File(path,"application/pdf","EduMaster_문제와해설.pdf",enableRangeProcessing:true)
    :Results.NotFound(new{error="이 세트에는 저장된 PDF가 없습니다. 생성 화면에서 학습 데이터 추가를 눌러 PDF와 함께 저장해 주세요."}));
app.MapPost("/api/learning/jobs/{id}",async(string id,HttpContext context)=>{
    var input=context.Request.HasJsonContentType()?await context.Request.ReadFromJsonAsync<LearningAddInput>(cancellationToken:context.RequestAborted):null;
    if(input?.PdfReportId is not { } pdfReportId || reportArchive.GetPdfPath(pdfReportId) is null)
        return Results.BadRequest(new{error="완성된 PDF를 먼저 저장해야 합니다. 생성 화면에서 학습 데이터 추가를 다시 눌러 주세요."});
    var alreadyAdded=learningArchive.HasJob(id);
    var count=0;
    if(jobs.TryGetValue(id,out var job)){
        if(job.State!="ready"||job.Outputs.Length==0||job.Outputs.Any(o=>o.State!="ready"||o.Result is null))
            return Results.Json(new{error="전체 문제와 해설이 완성된 뒤 학습 데이터로 추가해 주세요."},statusCode:409);
        await learningArchive.ImportAsync(id,job,context.RequestAborted,pdfReportId:pdfReportId);
        count=job.Outputs.Length;
    }else{
        count=await learningArchive.PromoteStagedJobAsync(id,context.RequestAborted,pdfReportId);
        if(count==0)return Results.NotFound(new{error="생성 결과를 찾지 못했습니다. 현재 결과가 보이는 상태에서 다시 생성해 주세요."});
    }
    if(input?.SourceId is { Length: > 0 } sourceId && sources.TryGetValue(sourceId,out var source) && DateTime.UtcNow-source.Created<TimeSpan.FromHours(2))
        await learningArchive.SaveOriginalPagesAsync(id,source.Pages,context.RequestAborted);
    return Results.Ok(new{added=true,pdfSaved=true,count,alreadyAdded,originalImagesSaved=learningArchive.GetOriginalPages(id).Length>0});
});
app.MapGet("/api/learning/jobs/{id}/originals",(string id)=>Results.Ok(learningArchive.GetOriginalPages(id)
    .Select(page=>new{page.Page,page.MaterialRole,page.DataUrl}).ToArray()));
app.MapGet("/api/learning/contents",()=>Results.Ok(learningArchive.ListLearned()));
app.MapGet("/api/learning/guidance",()=>Results.Ok(generationGuidance.Get()));
app.MapGet("/api/learning/prompts",()=>Results.Ok(GenerationPromptView.Get()));
app.MapPut("/api/learning/guidance",async(GenerationGuidanceInput input,HttpContext context)=>
    Results.Ok(await generationGuidance.SaveAsync(input.Do,input.Dont,context.RequestAborted)));
app.MapGet("/api/learning/problems/{id}",(string id)=>learningArchive.Get(id) is { } problem
    ?Results.Ok(problem):Results.NotFound(new{error="저장된 문제를 찾지 못했습니다."}));
app.MapDelete("/api/learning/problems/{id}",async(string id,HttpContext context)=>{
    try{await learningArchive.DeleteAsync(id,context.RequestAborted);return Results.Ok(new{deleted=true});}
    catch(KeyNotFoundException){return Results.NotFound(new{error="저장된 문제를 찾지 못했습니다."});}
});
app.MapPost("/api/learning/problems/{id}/feedback",async(string id,LearningFeedbackInput input,HttpContext context)=>{
    try{return Results.Ok(await learningArchive.AddFeedbackAsync(id,input.Category??"",input.Issue??"",input.Correction??"",input.Target??"problem",context.RequestAborted));}
    catch(KeyNotFoundException){return Results.NotFound(new{error="저장된 문제를 찾지 못했습니다."});}
});
app.MapPost("/api/learning/problems/{id}/feedback/{feedbackId}/review",async(string id,string feedbackId,LearningReviewInput input,HttpContext context)=>{
    if(input.Decision is not("approve" or "reject"))throw new ArgumentException("반영 승인 또는 제외를 선택해 주세요.");
    try{return Results.Ok(await learningArchive.ReviewAsync(id,feedbackId,input.Decision=="approve",context.RequestAborted));}
    catch(KeyNotFoundException){return Results.NotFound(new{error="피드백을 찾지 못했습니다."});}
});
app.MapPost("/api/solution",async(SolutionInput input,CancellationToken token)=>{
    if(input.Provider is not("gemma" or "deepseek"))throw new ArgumentException("풀이 생성 모델을 하나 선택해 주세요.");
    if(input.Provider=="deepseek")await deepseekAccount.EnsureAvailableAsync(deepseekKey,token);
    var title=(input.Title??"").Trim();var body=ReactionMassCheck.NormalizeSupportedOcr((input.Body??"").Trim());
    if(title.Length==0||body.Length<8||body.Length>12000)throw new ArgumentException("먼저 문제 이미지를 읽거나 문제 본문을 입력해 주세요.");
    VisualPage[]? images=null;
    if(input.SourceId is not null){if(!sources.TryGetValue(input.SourceId,out var stored)||DateTime.UtcNow-stored.Created>TimeSpan.FromHours(2))throw new ArgumentException("문제 이미지 보관 시간이 끝났습니다. 문제 이미지를 다시 넣어 주세요.");images=stored.Pages.Where(p=>p.MaterialRole!="solution").ToArray();}
    var model=input.Provider=="deepseek"?DeepSeekVisualGenerator.Model:(await generator.ProbeAsync(LocalGemmaGenerator.ConfiguredEndpoint,token,true)).Id;
    SolvedProblem solved;
    try{solved=await problemSolver.SolveAsync(title,body,input.Provider,model,deepseekKey,images,token);}
    catch(InvalidDataException){
        solved=await problemSolver.SolveAsync(title,body,input.Provider,model,deepseekKey,images,token);
        solved=solved with{Method=solved.Method+" · 첫 응답 중단 후 자동 재시도"};
    }
    return Results.Ok(new{body,solved.Answer,solved.Explanation,solved.Steps,solved.Method,verified=solved.Method.StartsWith("코드",StringComparison.Ordinal)});
});
app.MapPost("/api/generate",async(GenerationInput input,CancellationToken requestToken)=>{
    if(input.Provider is not("gemma" or "deepseek" or "both"))throw new ArgumentException("생성 모델을 선택해 주세요.");
    if(input.StageSeries&&input.Provider=="both")throw new ArgumentException("단계별 생성은 Gemma 또는 DeepSeek 중 한 모델을 선택해 주세요.");
    if(input.Provider!="gemma"&&deepseekKey.Length==0)throw new InvalidOperationException("서버의 DeepSeek API 키를 확인해 주세요.");
    VisualPage[]? images=null;
    if(input.RequiresImage || input.SourceId is not null){
        if(input.SourceId is null || !sources.TryGetValue(input.SourceId,out var stored) || DateTime.UtcNow-stored.Created>TimeSpan.FromHours(2))throw new ArgumentException("원본 이미지 보관 시간이 끝났거나 서버가 재시작됐습니다. 파일을 다시 넣어 주세요. 본문과 미리보기는 유지됩니다.");
        images=stored.Pages;
    }
    var draft=new ProblemDraft{Title=input.Title??"",Body=ReactionMassCheck.NormalizeSupportedOcr(input.Body??""),Answer=input.Answer??"",Explanation=input.Explanation??"",Steps=input.LogicSteps??[],FromSolution=input.FromSolution,UseSolutionLogic=input.UseSolutionLogic,VariantMode=input.VariantMode??"integrated"};
    if(draft.UseSolutionLogic&&ReactionMassCheck.Solve(draft.Body) is { } verifiedSource){
        if(!ReactionMassCheck.ReferenceAnswerMatches(draft.Answer,verifiedSource,draft.Body))throw new InvalidDataException($"기준 풀이 정답({draft.Answer})과 문제 조건의 독립 검산({verifiedSource.Answer})이 다릅니다. 문제와 풀이 입력을 다시 확인해 주세요.");
    }
    draft.Validate();
    if(draft.UseSolutionLogic){
        var probe=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),draft.Title,draft.Body,[],draft.Answer,draft.Explanation,draft.Steps,"입력 검산")
            {SourceProblem=draft.Body,SourceAnswer=draft.Answer,SourceExplanation=draft.Explanation};
        var sourceCheck=ProblemQualityHarness.Inspect(probe,draft).Checks.FirstOrDefault(c=>c.Id=="source-calculation");
        if(!GenerationQualityPolicy.CanStartFromSource(sourceCheck))throw new InvalidDataException("입력 문제와 제공된 해설이 서로 맞지 않습니다. "+sourceCheck!.Evidence);
    }
    if(input.StageSeries&&input.ExpectedStageCount is int expectedCount&&expectedCount!=draft.Steps.Length)
        return Results.Ok(new{planChanged=true,stageCount=draft.Steps.Length,logicSteps=draft.Steps,explanation=draft.Explanation,message=$"기준 풀이를 검산해 {draft.Steps.Length}개의 큰 단계로 정리했습니다. 생성할 문제 수를 확인한 뒤 다시 눌러 주세요."});
    _=ReactionVariantPlan.Create(draft); // Fail unclear source conditions before creating a paid generation job.
    var learningContext=string.Join("\n\n",new[]{generationGuidance.BuildPrompt(),learningArchive.Retrieve(draft)}.Where(x=>x.Length>0));
    var learningStages=input.StageSeries?LearningStagePlan.Build(draft):[];
    var checkedReactionSet=input.StageSeries?learningStages.Select(s=>ReactionLearningPlan.Create(s.Draft,s.Number,s.Total)).ToArray():[];
    if(input.Provider!="gemma"&&(learningContext.Length>0||checkedReactionSet.Length==0||checkedReactionSet.Any(r=>r is null)))await deepseekAccount.EnsureAvailableAsync(deepseekKey,requestToken);
    if(input.RequestId is not null&&!System.Text.RegularExpressions.Regex.IsMatch(input.RequestId,"^[a-f0-9]{32}$"))throw new ArgumentException("생성 요청 번호 형식이 올바르지 않습니다.");
    var sourceFingerprint=GenerationJobRegistry.SourceFingerprint(images);
    var requestFingerprint=GenerationJobRegistry.Fingerprint(draft,input.Provider,sourceFingerprint,input.RequiresImage)+"|stage-series="+input.StageSeries+"|prompt="+VariantResponse.PromptVersion+"|plan="+ReactionVariantPlan.Version+"|learning-plan="+ReactionLearningPlan.Version+"|quality="+QualityReport.CurrentVersion+"|learning="+LearningArchive.Digest(learningContext);
    foreach(var old in jobs.Where(x=>x.Value.Finished&&DateTime.UtcNow-x.Value.Created>GenerationResultCache.Retention).ToArray()){if(jobs.TryRemove(old.Key,out var removed)){removed.Cancel.Dispose();resultCache.Remove(old.Key);}}
    var started=jobRegistry.Start(input.RequestId,requestFingerprint,()=>new GenerationJob{Outputs=input.StageSeries
        ?learningStages.Select(s=>new ProviderJob(input.Provider,s.Number,s.Total,s.Label)).ToArray()
        :(input.Provider=="both"?new[]{"gemma","deepseek"}:new[]{input.Provider}).Select(p=>new ProviderJob(p)).ToArray()});
    if(started.Outcome is "existing" or "reused")return Results.Ok(new{id=started.Id,reused=started.Outcome=="reused"});
    if(started.Outcome=="full")return Results.Json(new{error="작업이 많습니다. 잠시 후 다시 시도해 주세요."},statusCode:429);
    if(started.Outcome=="busy")return Results.Json(new{error="다른 생성 작업이 진행 중입니다. 잠시 후 다시 눌러 주세요."},statusCode:409);
    var id=started.Id!;var job=started.Job!;
    // Only one quality rewrite per stage; all paid calls share a hard transport cap.
    // A single 12-minute deadline cancelled later stages even when earlier stages succeeded.
    job.Cancel.CancelAfter(TimeSpan.FromSeconds(input.StageSeries?480*Math.Max(1,job.Outputs.Length):720));
    _=Task.Run(async()=>{
        using var paidCalls=usageLedger.BeginScope(id,"generation",18);
        try{
            string? reactionFeedbackStyle=null;
            if(input.Provider=="deepseek"&&learningContext.Length>0&&checkedReactionSet.Length>0&&checkedReactionSet.All(r=>r is not null)){
                job.Phase="저장된 교사 지침·승인 사례의 적용 범위와 설명 방식 확인 중";
                reactionFeedbackStyle=await deepseek.ReadLearningPreferencesAsync(learningContext,deepseekKey,job.Cancel.Token);
            }
            async Task GenerateOne(ProviderJob output,ProblemDraft currentDraft){
                using var stageCalls=usageLedger.BeginStage("generation-stage-"+output.StageNumber);
                output.State="running";
                try{
                    var reactionStage=input.StageSeries?ReactionLearningPlan.Create(currentDraft,output.StageNumber,output.StageCount,reactionFeedbackStyle??"teacher"):null;
                    if(reactionStage is not null&&(learningContext.Length==0||reactionFeedbackStyle is not null)){
                        output.Result=reactionStage with{SourceProblem=draft.Body,SourceExplanation=draft.Explanation,SourceAnswer=draft.Answer,SourceSteps=draft.Steps,QualityJobId=id,Figures=images?.Select(p=>new PreservedFigure(p.Page,p.DataUrl,"기준 원본 이미지")).ToArray()??[],ImageInputCount=images?.Length??0,
                            GenerationNotice=reactionFeedbackStyle is null?reactionStage.GenerationNotice:$"저장된 지침·승인 피드백 적용 범위 확인 · {reactionFeedbackStyle} 설명 방식 · 문제·수식은 코드 생성·독립 검산 · 교사 확인 전",
                            UsageSummary=reactionFeedbackStyle is null?reactionStage.UsageSummary:"세트 전체의 피드백 설정 판독 1회 · 문항·해설 계산 생성에는 AI 호출 없음 · 사용량은 작업 토큰 기록 참조"};
                        output.State="prepared";output.Phase="반응량 표·정답·풀이 코드 검산 완료 · 문항 재작성 AI 호출 없음";return;
                    }
                    if(input.StageSeries&&learningContext.Length==0&&(currentDraft.IsPartialLearningStage||currentDraft.VariantMode=="numeric")&&SequentialNeutralizationCheck.CreateLearningStage(currentDraft,output.StageNumber,output.StageCount) is { } checkedStage){
                        output.Result=checkedStage with{QualityJobId=id};output.State="prepared";output.Phase="사전 검토 통과 · 전체 세트 확인 대기";return;
                    }
                    var prefix=output.StageNumber>0?$"전체 세트 사전 검토 · {output.StageLabel} ({output.StageNumber}/{output.StageCount}) · ":"";
                    var progress=new ImmediateProgress(s=>{output.Phase=s;job.Phase=prefix+s;});
                    async Task<SampleResult> GenerateReviewed(ProblemDraft attemptDraft){
                        var generated=output.Provider=="gemma"?await generator.GenerateAsync(attemptDraft,LocalGemmaGenerator.ConfiguredEndpoint,progress,job.Cancel.Token,images,learningContext):await deepseek.GenerateAsync(attemptDraft,deepseekKey,progress,job.Cancel.Token,images,learningContext);
                        generated=LearningStagePlan.RepairExposedConclusion(generated,attemptDraft);
                        generated=generated with{SourceProblem=draft.Body,SourceExplanation=draft.Explanation,SourceAnswer=draft.Answer,SourceSteps=draft.UseSolutionLogic?draft.Steps:[],LearningSteps=attemptDraft.Steps,VariantMode=attemptDraft.VariantMode,PriorStageIdeas=attemptDraft.PriorStageIdeas};
                        generated=VariantDesignPolicy.RemoveRedundantReactionContext(attemptDraft,generated);
                        generated=VariantDesignPolicy.ClarifyReactionMassResidual(generated);
                        return await qualityReviewer.ReviewTextAsync(generated,attemptDraft,output.Provider,output.Provider=="deepseek"?"https://api.deepseek.com":LocalGemmaGenerator.ConfiguredEndpoint,output.Provider=="deepseek"?DeepSeekVisualGenerator.Model:generated.RuntimeModelId,deepseekKey,progress,job.Cancel.Token);
                    }
                    async Task<SampleResult> RepairMethodIfNeeded(SampleResult candidate,ProblemDraft attemptDraft){
                        if(output.Provider!="deepseek"||candidate.Quality?.State!="fail")return candidate;
                        var checks=candidate.Quality.Checks;
                        if(!checks.Any(c=>c.State=="fail"&&(c.Id.StartsWith("source-method",StringComparison.Ordinal)||c.Id=="variant-design"&&c.Label.Contains("풀이 방식")))||checks.Any(c=>c.State=="fail"&&c.Id is "calculation" or "reaction-conditions" or "source-reaction-type" or "choices" or "variant-comparison"))return candidate;
                        var failures=string.Join(" | ",checks.Where(c=>c.State=="fail").Select(c=>c.Label+": "+c.Evidence));
                        try{
                            progress.Report("최종 문제 풀이 방식 보완 · 본문·정답 유지 후 재검토");
                            var repaired=await deepseek.RepairSolutionAsync(candidate,attemptDraft,failures,deepseekKey,job.Cancel.Token);
                            return await qualityReviewer.ReviewTextAsync(repaired,attemptDraft,output.Provider,"https://api.deepseek.com",DeepSeekVisualGenerator.Model,deepseekKey,progress,job.Cancel.Token);
                        }catch(Exception e)when(e is not DeepSeekStopException&&(e is InvalidDataException or HttpRequestException or InvalidOperationException)){
                            app.Logger.LogWarning("Solution repair did not pass: job={JobId}, stage={Stage}, exceptionType={ExceptionType}",id,output.StageNumber,e.GetType().Name);
                            return candidate;
                        }
                    }
                    async Task<SampleResult> GenerateWithFormatRetry(ProblemDraft attemptDraft){
                        try{return await GenerateReviewed(attemptDraft);}
                        catch(InvalidDataException e)when(output.Provider=="deepseek"&&!e.Data.Contains("DeepSeekFormatStage")&&!e.Data.Contains("DeepSeekOutputLimit")&&(e.Message.Contains("출력 한도")||e.Message.Contains("풀이 단계")||e.Message.Contains("응답 형식")||e.Message.Contains("그림 데이터")||e.Message.Contains("필수 그림")||e.Message.Contains("비커 그림"))){
                            progress.Report($"DeepSeek 응답 복구 · 풀이 {attemptDraft.Steps.Length}단계 형식으로 자동 재요청");
                            var recovery=$"\n[응답 복구] steps와 explanation은 suppliedSteps의 정확히 {attemptDraft.Steps.Length}단계만 작성한다. 선지 분석을 별도 STEP으로 추가하지 않는다. explanation은 단계마다 2~4문장, 전체 2200자 이내로 줄이고 완결된 JSON 하나만 반환한다. drawings의 모든 좌표는 도화지 너비·높이 안의 숫자로 쓰고 라벨을 겹치지 않는다. 복잡한 그림 대신 본문에 필요한 지점·축·화살표만 단순하게 그린다. 이전 오류: {e.Message}";
                            return await GenerateReviewed(attemptDraft with{LogicScope=(attemptDraft.LogicScope+recovery)[..Math.Min(1000,(attemptDraft.LogicScope+recovery).Length)]});
                        }
                    }
                    var workingDraft=currentDraft;
                    output.Result=await GenerateWithFormatRetry(workingDraft);
                    output.Result=await RepairMethodIfNeeded(output.Result,workingDraft);
                    const int rewriteLimit=1;
                    for(var rewrite=1;rewrite<=rewriteLimit&&output.Result.Quality?.State=="fail"&&output.Result.PromptVersion!=ReactionVariantPlan.Version;rewrite++){
                        var failures=string.Join(" | ",output.Result.Quality.Checks.Where(c=>c.State=="fail").Select(c=>c.Label+": "+c.Evidence));
                        progress.Report($"문제 검사 오류 · 같은 풀이 단계로 자동 재작성 {rewrite}/{rewriteLimit}");
                        var designHint=currentDraft.VariantMode=="integrated"&&ReactionMassCheck.Solve(currentDraft.Body) is not null
                            ?"\n[재작성 지침] 원본 표의 실험별 질량을 한 배수로 바꾸는 안은 폐기한다. x가 놓인 실험 행이나 알려 준 상댓값의 위치·수치를 새로 배치하고, 세 실험의 초기·잔류 질량을 공통 소비 질량비에 맞춰 독립적으로 설계한다. 원본 첫 STEP이 두 실험의 가정·모순 비교라면 첫 두 행의 잔류 질량은 각각 초기 A와 B 질량보다 모두 작아야 한다. 한 행의 불가능한 잔류량만으로 판별하는 쉬운 문제로 바꾸지 않는다. 보조 문자 도입과 상댓값 계산은 teacherMethod.stepContracts의 해당 STEP에만 배치한다. 새 수치로 b, x, 질문값과 보기 5개를 다시 계산한다."
                            :"\n[재작성 지침] 본문과 그림에 사용하는 모든 위치·거리·속도·표 값을 빠짐없이 함께 제시한다. 표의 각 칸을 활동 전위 그래프와 이동 시간으로 다시 계산하고, 해설은 지점 대응을 먼저 증명한 뒤 그 대응만 사용한다. 본문이나 그림에 없는 수치를 해설에서 새로 가정하지 않는다.";
                        var retryScope="[이전 초안 검사 실패] "+failures[..Math.Min(500,failures.Length)]+"\n위 오류를 피하되 suppliedSteps의 판단 과정은 그대로 유지해 처음부터 새 문제를 작성한다."+designHint+"\n"+currentDraft.LogicScope;
                        var revision=JsonSerializer.Serialize(new{body=output.Result.Body[..Math.Min(2500,output.Result.Body.Length)],answer=output.Result.Answer,
                            explanation=output.Result.Explanation[..Math.Min(850,output.Result.Explanation.Length)],steps=output.Result.Steps.Select(s=>s[..Math.Min(160,s.Length)]),failedChecks=failures[..Math.Min(700,failures.Length)]});
                        workingDraft=workingDraft with{Id=Guid.NewGuid(),LogicScope=retryScope[..Math.Min(1000,retryScope.Length)],RevisionCandidate=revision[..Math.Min(4200,revision.Length)]};
                        output.Result=await GenerateWithFormatRetry(workingDraft);
                        output.Result=await RepairMethodIfNeeded(output.Result,workingDraft);
                    }
                    if(output.Result.Quality?.State=="fail"){
                        var failures=string.Join(" | ",output.Result.Quality.Checks.Where(c=>c.State=="fail").Select(c=>c.Label+": "+c.Evidence));
                        throw new InvalidDataException("생성 문제의 조건·수치·해설 검사를 통과하지 못했습니다. 잘못된 문제는 완료로 표시하지 않습니다. "+failures);
                    }
                    if(!GenerationQualityPolicy.CanCompleteDraft(output.Result.Quality))
                        throw new InvalidDataException("생성 문제 검토 결과를 확인하지 못했습니다. 입력은 유지되므로 다시 검사해 주세요.");
                    output.Result=output.Result with{QualityJobId=id};
                    output.State=input.StageSeries?"prepared":"ready";output.Phase=input.StageSeries?"사전 검토 통과 · 전체 세트 확인 대기":"완료";
                }catch(DeepSeekStopException e){output.State="failed";output.Error=e.Message;throw;}
                catch(OperationCanceledException){output.State=job.UserCancelled?"cancelled":"failed";output.Error=job.UserCancelled?"생성을 취소했습니다.":"생성 시간이 초과됐습니다.";}
                catch(Exception e)when(e is ArgumentException or InvalidDataException or InvalidOperationException or UnsupportedProblemException){output.State="failed";if(!input.StageSeries)output.Result=null;output.Error=e.Message;app.Logger.LogWarning("Generation validation failed: job={JobId}, provider={Provider}, formatStage={FormatStage}, exceptionType={ExceptionType}, innerExceptionType={InnerExceptionType}",id,output.Provider,e.Data["DeepSeekFormatStage"]??"validation",e.GetType().Name,e.InnerException?.GetType().Name??"none");}
                catch(HttpRequestException){output.State="failed";output.Error="모델 서버에 연결하지 못했습니다.";}
                catch(Exception e){output.State="failed";output.Error="모델 생성 처리에 실패했습니다.";app.Logger.LogError("Generation unexpected error: job={JobId}, provider={Provider}, exceptionType={ExceptionType}",id,output.Provider,e.GetType().Name);}
                finally{if(output.State=="failed")app.Logger.LogWarning("Generation failed: job={JobId}, provider={Provider}, phase={Phase}, error={Error}",id,output.Provider,output.Phase,output.Error);}
            }
            if(input.StageSeries){
                for(var index=0;index<job.Outputs.Length;index++){
                    var stageDraft=learningStages[index].Draft;
                    if(job.Outputs[index].State=="prepared"){
                        if(job.Outputs[index].Result is { } previous){
                            var cleaned=VariantDesignPolicy.RemoveRedundantReactionContext(stageDraft,previous);
                            job.Outputs[index].Result=cleaned with{Quality=stageDraft.IsPartialLearningStage?ProblemQualityHarness.RefreshPartialStage(cleaned):ProblemQualityHarness.RefreshCompleted(cleaned)};
                        }
                        continue;
                    }
                    if(!stageDraft.IsPartialLearningStage&&stageDraft.VariantMode=="integrated"){
                        var ideas=TeacherMethodPolicy.PriorIdeas(job.Outputs.Take(index)
                            .Where(o=>o.State=="prepared"&&o.Result is not null).Select(o=>(o.StageLabel,o.Result!)));
                        stageDraft=stageDraft with{PriorStageIdeas=ideas};
                    }
                    await GenerateOne(job.Outputs[index],stageDraft);
                    if(job.StopAfterStageFailure(index))break;
                }
                job.PublishReviewedSet();
            }else await Task.WhenAll(job.Outputs.Select(output=>GenerateOne(output,draft)));
            job.Result=input.StageSeries?(job.State=="ready"?job.Outputs.LastOrDefault()?.Result:null):job.Outputs.FirstOrDefault(o=>o.State=="ready")?.Result;
            var allReady=job.Outputs.All(o=>o.State=="ready");
            job.State=allReady?"ready":job.UserCancelled?"cancelled":"failed";
            if(!allReady)job.Error=(input.StageSeries?"전체 세트 사전 검토에서 멈췄습니다. 통과한 초안은 보관되며 최종 결과로 표시하지 않습니다. 같은 입력으로 다시 만들면 통과한 초안을 재사용하고 실패한 문제만 다시 검토합니다. ":"")+string.Join(" · ",job.Outputs.Where(o=>o.State is not("ready" or "prepared")).Select(o=>(o.StageLabel.Length>0?o.StageLabel:o.Provider)+": "+(o.Error.Length>0?o.Error:o.Phase)));
        }
        catch(DeepSeekStopException e){
            job.State="failed";job.Error=e.Message;
            foreach(var output in job.Outputs.Where(o=>o.State is "waiting" or "running")){
                output.State="skipped";output.Phase="추가 유료 호출 중단";output.Error=e.Message;
            }
        }
        catch(OperationCanceledException){job.State=job.UserCancelled?"cancelled":"failed";job.Error=job.UserCancelled?"생성을 취소했습니다. 입력은 유지됩니다.":"생성 시간이 초과됐습니다. 입력은 유지됩니다. 한 문제만 남겨 다시 생성해 주세요.";}
        catch(Exception e) when(e is ArgumentException or InvalidDataException or InvalidOperationException or IOException or UnsupportedProblemException){job.State="failed";job.Error=e.Message;}
        catch(HttpRequestException){job.State="failed";job.Error="로컬 Gemma 서버에 연결하지 못했습니다.";}
        catch(Exception){job.State="failed";job.Error="생성 처리에 실패했습니다. 입력은 유지됩니다.";}
        finally{job.Finished=true;try{await resultCache.SaveAsync(id,job);}catch(Exception e)when(e is IOException or JsonException or UnauthorizedAccessException){app.Logger.LogWarning("Job result cache save failed: job={JobId}, exceptionType={ExceptionType}",id,e.GetType().Name);}if(job.State=="ready")try{await learningArchive.StageAsync(id,job);}catch(Exception e)when(e is IOException or JsonException or UnauthorizedAccessException){app.Logger.LogWarning("Learning staging failed: job={JobId}, exceptionType={ExceptionType}",id,e.GetType().Name);}gate.Release();}
    });
    return Results.Ok(new{id,stageSeries=input.StageSeries,stageCount=input.StageSeries?learningStages.Length:0});
});
app.MapGet("/api/jobs/{id}",(string id,HttpContext context)=>jobs.TryGetValue(id,out var j)?Results.Ok(new{usage=usageLedger.Summary(id),state=j.State,phase=j.Phase,stageSeries=j.IsStageSeries,stageCount=j.Outputs.Max(o=>o.StageCount),preparedCount=j.Outputs.Count(o=>o.State is "prepared" or "ready"),elapsedSeconds=(int)(DateTime.UtcNow-j.Created).TotalSeconds,error=j.Error,result=RendererCompatibility.ForClient(j.IsStageSeries&&j.State!="ready"?null:j.Result,context.Request.Headers["X-EduMaster-Renderer"].ToString()),outputs=j.Outputs.Select(o=>new{provider=o.Provider,model=o.Model,stageNumber=o.StageNumber,stageCount=o.StageCount,stageLabel=o.StageLabel,state=o.State,phase=o.Phase,error=o.Error,result=RendererCompatibility.ForClient(j.VisibleResult(o),context.Request.Headers["X-EduMaster-Renderer"].ToString())})}):Results.NotFound());
app.MapPost("/api/jobs/{id}/retry-check",async(string id,HttpContext context)=>{
    if(!jobs.TryGetValue(id,out var job))return Results.NotFound();
    if(!job.IsStageSeries||!job.Finished||job.Outputs.Length<2||job.Outputs[^1] is not {Provider:"deepseek",Result:{ } candidate} output)
        return Results.Json(new{error="재검토할 탈락 초안이 없습니다."},statusCode:409);
    var restoring=job.State=="failed"&&output.State=="failed"&&job.Outputs[..^1].All(o=>o.State=="prepared");
    var clarifying=job.State=="ready"&&job.Outputs.All(o=>o.State=="ready")&&(candidate.Body.Contains("반응 후 잔류 질량",StringComparison.Ordinal)||candidate.Body.Contains(".| 실험 |",StringComparison.Ordinal));
    if(!restoring&&!clarifying)return Results.Json(new{error="재검토가 필요한 작업이 아닙니다."},statusCode:409);
    if(!await job.ReviewGate.WaitAsync(0))return Results.Json(new{error="이미 같은 작업을 재검토 중입니다."},statusCode:409);
    try{
        var source=TeacherMethodPolicy.RestoreReference(candidate,false)??new ProblemDraft{Title=candidate.Title,Body=candidate.SourceProblem,Answer=candidate.SourceAnswer,Explanation=candidate.SourceExplanation,Steps=candidate.SourceSteps,UseSolutionLogic=true,VariantMode="integrated"};
        var repaired=VariantDesignPolicy.ClarifyReactionMassResidual(VariantDesignPolicy.RemoveRedundantReactionContext(source,candidate)) with{Quality=null};
        var initial=ProblemQualityHarness.Inspect(repaired);
        var methodFailures=initial.Checks.Where(c=>c.State=="fail"&&c.Id.StartsWith("source-method",StringComparison.Ordinal)).ToArray();
        if(methodFailures.Length>0&&initial.Checks.Any(c=>c.Id=="calculation"&&c.State=="pass")
            &&!initial.Checks.Any(c=>c.State=="fail"&&c.Id is "calculation" or "reaction-conditions" or "source-reaction-type" or "choices" or "variant-comparison")){
            job.Phase="검산된 최종 문제 유지 · 원본 STEP 순서로 해설 보완 중";
            repaired=await deepseek.RepairSolutionAsync(repaired,source,string.Join(" | ",methodFailures.Select(c=>c.Evidence)),deepseekKey,context.RequestAborted);
        }
        var design=VariantDesignPolicy.Inspect(source,repaired);
        if(design?.State=="fail")return Results.Json(new{error=design.Evidence},statusCode:422);
        var reviewed=await qualityReviewer.ReviewTextAsync(repaired,null,output.Provider,"https://api.deepseek.com",DeepSeekVisualGenerator.Model,deepseekKey,token:context.RequestAborted);
        var report=reviewed.Quality!;
        if(design is not null)report=ProblemQualityHarness.Merge(report,[design]);
        if(!GenerationQualityPolicy.CanCompleteDraft(report)||report.Checks.Any(c=>c.State=="fail")||!report.Checks.Any(c=>c.Id=="calculation"&&c.State=="pass")){
            output.Result=reviewed with{Quality=report,QualityJobId=id};
            if(restoring){output.State="failed";output.Error=string.Join(" | ",report.Checks.Where(c=>c.State=="fail").Select(c=>c.Evidence));}
            await resultCache.SaveAsync(id,job);
            return Results.Json(new{error="기존 초안이 재검토를 통과하지 못했습니다.",checks=report.Checks.Where(c=>c.State is "fail" or "unknown").Select(c=>new{c.Id,c.State,c.Evidence})},statusCode:422);
        }
        output.Result=reviewed with{Quality=report,QualityJobId=id};output.Error="";
        if(restoring){
            output.State="prepared";output.Phase="기존 초안 재검토 통과 · 전체 세트 확인 대기";
            if(!job.PublishReviewedSet())return Results.Json(new{error="앞 단계 검토 결과를 확인하지 못했습니다."},statusCode:422);
        }else{
            output.Phase="표의 잔류 질량 의미 재검토 완료";job.Result=output.Result;job.Phase="최종 문제 표 설명 재검토 완료";
        }
        job.Error="";job.Finished=true;
        await resultCache.SaveAsync(id,job);
        await learningArchive.StageAsync(id,job);
        return Results.Ok(new{id,state=job.State,stageCount=job.Outputs.Length});
    }finally{job.ReviewGate.Release();}
});
app.MapPost("/api/jobs/{id}/cancel",(string id)=>{if(!jobs.TryGetValue(id,out var j))return Results.NotFound();if(!j.Finished){j.UserCancelled=true;j.Cancel.Cancel();}return Results.Ok();});
app.MapPost("/api/jobs/{id}/text-check",async(string id,TextReviewInput input,HttpContext context)=>{
    if(!jobs.TryGetValue(id,out var job))return Results.NotFound();
    var output=job.Outputs.FirstOrDefault(o=>o.Result?.Id==input.ResultId);
    if(output?.Result is not { } result)return Results.NotFound();
    if(!await job.ReviewGate.WaitAsync(0))return Results.Json(new{error="같은 결과를 검사 중입니다. 완료 후 다시 검사해 주세요."},statusCode:409);
    try{
        var partialStage=output.StageNumber>0&&output.StageNumber<output.StageCount;
        var learningScope=partialStage?$"중간 {output.StageNumber}/{output.StageCount}단계 연습 문제입니다. 기준 풀이의 STEP 1부터 STEP {output.StageNumber}까지만 사용해야 합니다.":null;
        var reviewed=await qualityReviewer.ReviewTextAsync(result,null,output.Provider,output.Provider=="deepseek"?"https://api.deepseek.com":LocalGemmaGenerator.ConfiguredEndpoint,output.Provider=="deepseek"?DeepSeekVisualGenerator.Model:result.RuntimeModelId,deepseekKey,token:context.RequestAborted,partialLearningStage:partialStage,learningScope:learningScope);
        var report=reviewed.Quality!;
        // Input identity was checked with the original draft during generation. Preserve that evidence.
        if(result.Quality is { } old){report=ProblemQualityHarness.Merge(report,old.Checks.Where(c=>c.Id=="render")) with{Checks=report.Checks.Where(c=>c.Id!="render").Concat(old.Checks.Where(c=>c.Id is "input" or "render")).ToArray(),RenderHash=old.RenderHash,RenderReviewVersion=old.RenderReviewVersion};}
        report=ProblemQualityHarness.MarkSkippedAfterFailure(report);
        output.Result=reviewed with{Quality=report};if(job.Result?.Id==result.Id)job.Result=output.Result;
        await learningArchive.UpdateResultAsync(output.Result,context.RequestAborted);
        await resultCache.SaveAsync(id,job,context.RequestAborted);return Results.Ok(report);
    }finally{job.ReviewGate.Release();}
});
app.MapPost("/api/jobs/{id}/render-check",async(string id,RenderReviewInput input,HttpContext context)=>{
    if(!jobs.TryGetValue(id,out var job))return Results.NotFound();
    var output=job.Outputs.FirstOrDefault(o=>o.Result?.Id==input.ResultId);
    if(output?.Result is not { } result)return Results.NotFound();
    if(!await job.ReviewGate.WaitAsync(0))return Results.Json(new{error="최종 이미지 검사 중입니다. 잠시 후 같은 결과를 확인해 주세요."},statusCode:409);
    try{
        var png=RenderedImageInput.Decode(input.Png);var hash=Convert.ToHexString(SHA256.HashData(png));
        var partialStage=output.StageNumber>0&&output.StageNumber<output.StageCount;
        var inspected=ProblemQualityHarness.Inspect(result,null,partialStage);
        var report=result.Quality??inspected;
        var codeUpdates=inspected.Checks.Where(c=>c.Method=="code"&&!((c.State=="unknown")&&report.Checks.Any(old=>old.Id==c.Id&&old.State=="pass")));
        report=ProblemQualityHarness.Merge(report,codeUpdates);
        if(report.Checks.Any(c=>c.Method=="code"&&c.State=="fail")){
            report=ProblemQualityHarness.MarkSkippedAfterFailure(ProblemQualityHarness.Merge(report,[new QualityCheck("render","최종 PNG 대조","skipped","코드 검사에서 문항 오류를 발견해 이미지 모델 호출을 생략했습니다. 문제를 수정하거나 원본 입력으로 재생성해 주세요.","code")])) with{RenderHash=null};
        }
        else if(report.RenderHash!=hash||report.RenderReviewVersion!=QualityReviewClient.RenderVersion){
            var check=await qualityReviewer.ReviewRenderedAsync(result,png,input.IncludeAnswer,context.RequestAborted);
            report=ProblemQualityHarness.Merge(report,[check]) with{RenderHash=check.State=="pass"?hash:null,RenderReviewVersion=QualityReviewClient.RenderVersion};
        }
        output.Result=result with{Quality=report};if(job.Result?.Id==result.Id)job.Result=output.Result;
        await learningArchive.UpdateResultAsync(output.Result,context.RequestAborted);
        await resultCache.SaveAsync(id,job,context.RequestAborted);
        return Results.Ok(report);
    }catch(ArgumentException e){return Results.BadRequest(new{error=e.Message});}
    catch(IOException){return Results.Json(new{error="검사 기록을 보관하지 못했습니다. 같은 작업을 다시 확인해 주세요."},statusCode:503);}
    finally{job.ReviewGate.Release();}
});
_=Task.Run(async()=>{using var timer=new PeriodicTimer(TimeSpan.FromMinutes(1));try{while(await timer.WaitForNextTickAsync(app.Lifetime.ApplicationStopping)){foreach(var old in sources.Where(x=>DateTime.UtcNow-x.Value.Created>TimeSpan.FromHours(2)).ToArray()){sources.TryRemove(old.Key,out _);sourceCache.Remove(old.Key);}foreach(var old in jobs.Where(x=>x.Value.Finished&&DateTime.UtcNow-x.Value.Created>GenerationResultCache.Retention).ToArray()){if(jobs.TryRemove(old.Key,out var removed)){removed.Cancel.Dispose();resultCache.Remove(old.Key);}}}}catch(OperationCanceledException){}});
app.Run();

record GenerationInput(string? Title,string? Body,string? Answer,string? Explanation,string? SourceId=null,bool RequiresImage=false,bool FromSolution=false,string Provider="gemma",string? RequestId=null,bool UseSolutionLogic=false,string[]? LogicSteps=null,bool StageSeries=false,int? ExpectedStageCount=null,string? VariantMode="integrated");
record ReportSaveInput(string? Title,string? Html);
record SolutionInput(string? Title,string? Body,string Provider="deepseek",string? SourceId=null);
record RenderReviewInput(Guid ResultId,string Png,bool IncludeAnswer=false);
record TextReviewInput(Guid ResultId);
record LearningFeedbackInput(string? Category,string? Issue,string? Correction,string? Target=null);
record LearningReviewInput(string? Decision);
record LearningAddInput(string? SourceId, string? PdfReportId);
record GenerationGuidanceInput(string? Do,string? Dont);

sealed class ImmediateProgress(Action<string> action):IProgress<string>{public void Report(string value)=>action(value);}
