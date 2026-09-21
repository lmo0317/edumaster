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
if(!File.Exists(configPath))File.WriteAllText(configPath,"woodhair249");
string GetAccess()=>File.Exists(configPath)?File.ReadAllText(configPath).Trim():"";
var jobRegistry=new GenerationJobRegistry();var jobs=jobRegistry.Jobs;var gate=jobRegistry.Gate;var importGate=new SemaphoreSlim(1);
var completedImports=new ConcurrentDictionary<string,(DateTime Created,IResult Response)>();
var resultCache=new GenerationResultCache(Path.Combine(app.Environment.ContentRootPath,"job-cache"));
foreach(var saved in resultCache.Load(DateTime.UtcNow)){
    foreach(var output in saved.Value.Outputs)if(output.Result is not null){var partial=output.StageNumber>0&&output.StageNumber<output.StageCount;var restored=LearningStagePlan.RepairExposedConclusion(output.Result,output.Result.SourceSteps,partial);var quality=partial?ProblemQualityHarness.RefreshPartialStage(restored):ProblemQualityHarness.RefreshCompleted(restored);output.Result=restored with{QualityJobId=saved.Key,Quality=quality};}
    saved.Value.Result=saved.Value.Outputs.FirstOrDefault(o=>o.State=="ready")?.Result;jobs[saved.Key]=saved.Value;
}
using var client=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(480)};
var generator=new LocalGemmaGenerator(client);
var deepseek=new DeepSeekVisualGenerator(client);
var problemSolver=new ProblemSolver(client);
var qualityReviewer=new QualityReviewClient(client);
var deepseekKeyPath=Path.Combine(app.Environment.ContentRootPath,"deepseek-api-key.txt");
var deepseekKey=File.Exists(deepseekKeyPath)?File.ReadAllText(deepseekKeyPath).Trim():"";
var sourceCache=new ImageSourceCache(Path.Combine(app.Environment.ContentRootPath,"source-cache"));
var sources=new ConcurrentDictionary<string,ImageSource>(sourceCache.Load(DateTime.UtcNow));
var reportArchive=new ReportArchive(Path.Combine(app.Environment.ContentRootPath,"reports"),Path.Combine(app.Environment.WebRootPath,"style.css"));
app.Use(async(context,next)=>{
    context.Response.Headers.CacheControl="no-store";context.Response.Headers["Referrer-Policy"]="no-referrer";
    context.Response.Headers["X-Content-Type-Options"]="nosniff";
    context.Response.Headers["Content-Security-Policy"]="default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    if(context.Request.Path.StartsWithSegments("/api")){
        var supplied=context.Request.Headers.Authorization.ToString();var expected="Bearer "+GetAccess();
        var authorized=CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied),Encoding.UTF8.GetBytes(expected));
        if(!authorized){context.Response.StatusCode=401;await context.Response.WriteAsJsonAsync(new{error="비밀번호가 올바르지 않습니다."});return;}
    }
    try{await next(context);}catch(Exception e) when(e is ArgumentException or InvalidDataException or InvalidOperationException or IOException or System.Runtime.InteropServices.COMException or System.Xml.XmlException or BadHttpRequestException){
        app.Logger.LogWarning(e,"Request failed: {Path}",context.Request.Path);
        if(!context.Response.HasStarted){context.Response.StatusCode=400;await context.Response.WriteAsJsonAsync(new{error=e is BadHttpRequestException?"파일은 10MB까지 지원합니다.":e.Message});}
    }catch(OperationCanceledException){if(!context.Response.HasStarted){context.Response.StatusCode=context.RequestAborted.IsCancellationRequested?499:408;if(!context.RequestAborted.IsCancellationRequested)await context.Response.WriteAsJsonAsync(new{error="파일 읽기 시간이 초과됐습니다. 문제 한 개의 선명한 이미지로 다시 넣어 주세요."});}}
    catch(Exception){if(!context.Response.HasStarted){context.Response.StatusCode=500;await context.Response.WriteAsJsonAsync(new{error="처리하지 못했습니다. 입력은 유지됩니다. 파일과 서버 상태를 확인해 주세요."});}}
});
app.UseDefaultFiles();app.UseStaticFiles();
app.MapGet("/result",()=>Results.Redirect("./result/"));
app.MapGet("/api/status",async(CancellationToken token)=>{
    LocalModel? gemmaModel=null;
    try{using var timeout=CancellationTokenSource.CreateLinkedTokenSource(token);timeout.CancelAfter(TimeSpan.FromSeconds(3));gemmaModel=await generator.ProbeAsync(LocalGemmaGenerator.ConfiguredEndpoint,timeout.Token,requireVision:true);}catch(Exception) when(!token.IsCancellationRequested){}
    var deepseekConfigured=deepseekKey.Length>0;
    return Results.Ok(new{ready=deepseekConfigured||gemmaModel is not null,vision=true,model=deepseekConfigured?DeepSeekVisualGenerator.DisplayName:gemmaModel?.Name??"모델 연결 없음",deepseekConfigured,deepseekModel=DeepSeekVisualGenerator.DisplayName,gemmaAvailable=gemmaModel is not null,gemmaModel=gemmaModel?.Name??"Gemma 4 12B",gemmaAvailabilityText=gemmaModel is not null?"현재 PC 연결됨":"현재 PC가 켜져 있을 때만 사용 가능",context=gemmaModel?.ContextSize,version="0.7.0-linux-backend",publicTest=false});
});
app.MapGet("/api/sources/{id}",(string id,bool? preview)=>sources.TryGetValue(id,out var source)&&DateTime.UtcNow-source.Created<TimeSpan.FromHours(2)
    ?Results.Ok(new{ready=true,expiresAt=source.Created.AddHours(2),pageCount=source.Pages.Length,previewDataUrl=preview==true?source.Pages[0].DataUrl:null,previewDataUrls=preview==true?source.Pages.Select(p=>p.DataUrl).ToArray():null,previewMaterialRoles=preview==true?source.Pages.Select(p=>p.MaterialRole).ToArray():null}) :Results.Ok(new{ready=false}));
app.MapPost("/api/import",async(HttpRequest request,CancellationToken requestToken)=>{
    using var deadline=CancellationTokenSource.CreateLinkedTokenSource(requestToken);deadline.CancelAfter(TimeSpan.FromSeconds(300));var token=deadline.Token;var gateAcquired=false;
    try{
    await importGate.WaitAsync(token);gateAcquired=true;
    if(!request.HasFormContentType)throw new ArgumentException("파일을 선택해 주세요.");
    var form=await request.ReadFormAsync(token);var readingProvider=form["provider"].ToString();var materialKind=form["materialKind"].ToString();var importRequestId=form["requestId"].ToString();
    if(importRequestId.Length>0&&!System.Text.RegularExpressions.Regex.IsMatch(importRequestId,"^[a-f0-9]{32}$"))throw new ArgumentException("이미지 분석 요청 번호 형식이 올바르지 않습니다.");
    if(importRequestId.Length>0&&completedImports.TryGetValue(importRequestId,out var completed)&&DateTime.UtcNow-completed.Created<TimeSpan.FromHours(2))return completed.Response;
    var combined=materialKind=="problem-solution";var separate=materialKind=="problem-solution-separate";var problemOnly=materialKind=="problem-only";
    if(!combined&&!separate&&!problemOnly)throw new ArgumentException("문제와 풀이 입력 방식을 확인해 주세요.");
    if(readingProvider!=""&&readingProvider is not("gemma" or "deepseek" or "both"))throw new ArgumentException("생성 모델을 선택해 주세요.");
    var cloudReading=readingProvider is "deepseek" or "both";
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
                pages=[pages[0] with{Page=1,MaterialRole="question"},second.Pages[0] with{Page=2,MaterialRole="solution"}];views=pages;
            }else if(combined){
                if(pages.Length!=1)throw new ArgumentException("한 장 입력은 문제와 풀이가 함께 보이는 이미지 한 장 또는 한 페이지 PDF를 사용해 주세요.");
                views=await LocalDocumentReader.MaterialViewsAsync(pages[0],token);
            }else{
                if(pages.Length!=1)throw new ArgumentException("문제 파일은 이미지 한 장 또는 한 페이지 PDF로 넣어 주세요.");
                pages=[pages[0] with{Page=1,MaterialRole="question"}];views=pages;
            }
            async Task<(ProblemSolutionMaterial Material,bool Retried)> ReadDeepSeekMaterial(){
                try{return(await deepseek.ReadMaterialAsync(pages[0],deepseekKey,token,views),false);}
                catch(InvalidDataException){return(await deepseek.ReadMaterialAsync(pages[0],deepseekKey,token,views),true);}
            }
            if(problemOnly){
                body=cloudReading?await deepseek.ReadAsync(pages[0],deepseekKey,token):await reader.ReadAsync(pages[0].Bytes,pages[0].MimeType,token);
                body=ReactionMassCheck.NormalizeSupportedOcr(body);
            }else{
                if(cloudReading){var read=await ReadDeepSeekMaterial();material=read.Material;if(read.Retried)material=material with{Uncertainties=material.Uncertainties.Concat(["첫 이미지 분석 응답의 형식을 읽지 못해 서버가 자동으로 한 번 더 분석했습니다."]).Distinct().ToArray()};materialReaderName=DeepSeekVisualGenerator.DisplayName;}
                else{
                    var model=await generator.ProbeAsync(LocalGemmaGenerator.ConfiguredEndpoint,token,true);
                    try{material=await reader.ReadMaterialAsync(pages[0],token,LocalGemmaGenerator.ConfiguredEndpoint,model.Id,views);materialReaderName="로컬 Gemma 4 12B";}
                    catch(InvalidDataException) when(deepseekKey.Length>0){
                        var read=await ReadDeepSeekMaterial();material=read.Material;
                        material=material with{Uncertainties=material.Uncertainties.Concat(["Gemma가 표 또는 STEP 구조를 안정적으로 읽지 못해 DeepSeek 이미지 분석으로 자동 보정했습니다. 생성 모델 선택은 변경하지 않았습니다."]).Concat(read.Retried?["DeepSeek의 첫 응답 형식도 읽지 못해 서버가 자동으로 한 번 더 분석했습니다."]:[]).Distinct().ToArray()};
                        materialReaderName=DeepSeekVisualGenerator.DisplayName+" 자동 보정";
                    }
                }
                material=material.WithVerifiedLogic();body=material.Body;
            }
            foreach(var old in sources.Where(x=>DateTime.UtcNow-x.Value.Created>TimeSpan.FromHours(2)).ToArray()){sources.TryRemove(old.Key,out _);sourceCache.Remove(old.Key);}
            if(sources.Count>=10)throw new InvalidOperationException("이미지 보관 작업이 많습니다. 잠시 후 다시 넣어 주세요.");
            sourceId=Guid.NewGuid().ToString("N");var storedSource=new ImageSource(pages,DateTime.UtcNow);await sourceCache.SaveAsync(sourceId,storedSource,token);sources[sourceId]=storedSource;
        }
        var displayName=separate?Path.GetFileName(questionFile!.FileName)+" + "+Path.GetFileName(solutionFile!.FileName):Path.GetFileName((file??questionFile)!.FileName);
        IResult response=Results.Ok(new{title=Path.GetFileNameWithoutExtension(Path.GetFileName((file??questionFile!).FileName)),body,answer=material?.Answer??"",explanation=material?.Explanation??"",steps=material?.Steps??[],uncertainties=material?.Uncertainties??[],materialKind=problemOnly?"problem-only":"problem-solution-separate",sourceId,sourceExpiresAt=sourceId is null?(DateTime?)null:sources[sourceId].Created.AddHours(2),fileName=displayName,readMethod=material is not null?materialReaderName+" 문제·풀이 분리":first.Draft.Source.IsAttachment?(cloudReading?DeepSeekVisualGenerator.DisplayName+" 원본 이미지 인식":LocalVisionReader.ReadMethod):"본문 추출",needsReview=first.Draft.Source.IsAttachment,previewDataUrl=pages.Length>0?pages[0].DataUrl:null,previewDataUrls=pages.Select(p=>p.DataUrl).ToArray(),previewMaterialRoles=pages.Select(p=>p.MaterialRole).ToArray()});
        foreach(var old in completedImports.Where(item=>DateTime.UtcNow-item.Value.Created>TimeSpan.FromHours(2)).ToArray())completedImports.TryRemove(old.Key,out _);
        if(importRequestId.Length>0)completedImports[importRequestId]=(DateTime.UtcNow,response);
        return response;
    }finally{Directory.Delete(directory,true);}
    }finally{if(gateAcquired)importGate.Release();}
});
app.MapGet("/api/reports",()=>Results.Ok(reportArchive.List().Select(r=>new{r.Id,r.Title,r.CreatedAt,r.Size})));
app.MapPost("/api/reports",async(ReportSaveInput input,HttpContext context)=>{
    var saved=await reportArchive.SaveAsync(input.Title,input.Html,context.RequestAborted);
    return Results.Ok(new{saved.Id,saved.Title,saved.CreatedAt,saved.Size});
});
app.MapGet("/api/reports/{id}/file",(string id,bool? download)=>reportArchive.GetPdfPath(id) is { } path
    ?Results.File(path,"application/pdf",download==true?Path.GetFileNameWithoutExtension(path)+".pdf":null,enableRangeProcessing:true)
    :Results.NotFound(new{error="저장된 PDF를 찾지 못했습니다."}));
app.MapPost("/api/solution",async(SolutionInput input,CancellationToken token)=>{
    if(input.Provider is not("gemma" or "deepseek"))throw new ArgumentException("풀이 생성 모델을 하나 선택해 주세요.");
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
app.MapPost("/api/generate",(GenerationInput input)=>{
    if(input.Provider is not("gemma" or "deepseek" or "both"))throw new ArgumentException("생성 모델을 선택해 주세요.");
    if(input.StageSeries&&input.Provider=="both")throw new ArgumentException("단계별 생성은 Gemma 또는 DeepSeek 중 한 모델을 선택해 주세요.");
    if(input.Provider!="gemma"&&deepseekKey.Length==0)throw new InvalidOperationException("서버의 DeepSeek API 키를 확인해 주세요.");
    VisualPage[]? images=null;
    if(input.RequiresImage || input.SourceId is not null){
        if(input.SourceId is null || !sources.TryGetValue(input.SourceId,out var stored) || DateTime.UtcNow-stored.Created>TimeSpan.FromHours(2))throw new ArgumentException("원본 이미지 보관 시간이 끝났거나 서버가 재시작됐습니다. 파일을 다시 넣어 주세요. 본문과 미리보기는 유지됩니다.");
        images=stored.Pages;
    }
    var draft=new ProblemDraft{Title=input.Title??"",Body=ReactionMassCheck.NormalizeSupportedOcr(input.Body??""),Answer=input.Answer??"",Explanation=input.Explanation??"",Steps=input.LogicSteps??[],FromSolution=input.FromSolution,UseSolutionLogic=input.UseSolutionLogic};
    if(draft.UseSolutionLogic&&AcidBaseMixtureCheck.SolveSource(draft.Body) is { } verifiedIons)
        draft=draft with{Answer=verifiedIons.Answer,Explanation=verifiedIons.Explanation,Steps=verifiedIons.Steps};
    if(draft.UseSolutionLogic&&GasMixtureAtomCheck.VerifySource(new ProblemSolutionMaterial(draft.Body,draft.Answer,draft.Explanation,draft.Steps,[])) is { } verifiedMixture)
        draft=draft with{Explanation=verifiedMixture.Explanation,Steps=verifiedMixture.Steps};
    if(draft.UseSolutionLogic&&ReactionMassCheck.Solve(draft.Body) is { } verifiedSource){
        if(!ReactionMassCheck.ReferenceAnswerMatches(draft.Answer,verifiedSource))throw new InvalidDataException($"기준 풀이 정답({draft.Answer})과 문제 조건의 독립 검산({verifiedSource.Answer})이 다릅니다. 문제와 풀이 입력을 다시 확인해 주세요.");
    }
    draft.Validate();
    if(draft.UseSolutionLogic){
        var probe=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),draft.Title,draft.Body,[],draft.Answer,draft.Explanation,draft.Steps,"입력 검산")
            {SourceProblem=draft.Body,SourceAnswer=draft.Answer,SourceExplanation=draft.Explanation};
        var sourceCheck=ProblemQualityHarness.Inspect(probe,draft).Checks.FirstOrDefault(c=>c.Id=="source-calculation");
        if(sourceCheck?.State!="pass")throw new InvalidDataException("입력 문제의 정답을 독립 검산하지 못했습니다. 미검증 풀이로 문제 생성을 시작하지 않습니다. "+(sourceCheck?.Evidence??"원본 조건을 확인해 주세요."));
    }
    if(input.StageSeries&&input.ExpectedStageCount is int expectedCount&&expectedCount!=draft.Steps.Length)
        return Results.Ok(new{planChanged=true,stageCount=draft.Steps.Length,logicSteps=draft.Steps,explanation=draft.Explanation,message=$"기준 풀이를 검산해 {draft.Steps.Length}개의 큰 단계로 정리했습니다. 생성할 문제 수를 확인한 뒤 다시 눌러 주세요."});
    _=ReactionVariantPlan.Create(draft); // Fail unclear source conditions before creating a paid generation job.
    var learningStages=input.StageSeries?LearningStagePlan.Build(draft):[];
    if(input.RequestId is not null&&!System.Text.RegularExpressions.Regex.IsMatch(input.RequestId,"^[a-f0-9]{32}$"))throw new ArgumentException("생성 요청 번호 형식이 올바르지 않습니다.");
    var sourceFingerprint=GenerationJobRegistry.SourceFingerprint(images);
    var requestFingerprint=GenerationJobRegistry.Fingerprint(draft,input.Provider,sourceFingerprint,input.RequiresImage)+"|stage-series="+input.StageSeries+"|prompt="+VariantResponse.PromptVersion+"|plan="+ReactionVariantPlan.Version+"|quality="+QualityReport.CurrentVersion;
    foreach(var old in jobs.Where(x=>x.Value.Finished&&DateTime.UtcNow-x.Value.Created>GenerationResultCache.Retention).ToArray()){if(jobs.TryRemove(old.Key,out var removed)){removed.Cancel.Dispose();resultCache.Remove(old.Key);}}
    var started=jobRegistry.Start(input.RequestId,requestFingerprint,()=>new GenerationJob{Outputs=input.StageSeries
        ?learningStages.Select(s=>new ProviderJob(input.Provider,s.Number,s.Total,s.Label)).ToArray()
        :(input.Provider=="both"?new[]{"gemma","deepseek"}:new[]{input.Provider}).Select(p=>new ProviderJob(p)).ToArray()});
    if(started.Outcome is "existing" or "reused")return Results.Ok(new{id=started.Id,reused=started.Outcome=="reused"});
    if(started.Outcome=="full")return Results.Json(new{error="작업이 많습니다. 잠시 후 다시 시도해 주세요."},statusCode:429);
    if(started.Outcome=="busy")return Results.Json(new{error="다른 생성 작업이 진행 중입니다. 잠시 후 다시 눌러 주세요."},statusCode:409);
    var id=started.Id!;var job=started.Job!;
    _=Task.Run(async()=>{
        try{
            async Task GenerateOne(ProviderJob output,ProblemDraft currentDraft){
                output.State="running";
                try{
                    var prefix=output.StageNumber>0?$"{output.StageLabel} ({output.StageNumber}/{output.StageCount}) · ":"";
                    var progress=new ImmediateProgress(s=>{output.Phase=s;job.Phase=prefix+s;});
                    async Task<SampleResult> GenerateReviewed(ProblemDraft attemptDraft){
                        var generated=output.Provider=="gemma"?await generator.GenerateAsync(attemptDraft,LocalGemmaGenerator.ConfiguredEndpoint,progress,job.Cancel.Token,images):await deepseek.GenerateAsync(attemptDraft,deepseekKey,progress,job.Cancel.Token,images);
                        generated=LearningStagePlan.RepairExposedConclusion(generated,attemptDraft);
                        generated=generated with{SourceExplanation=attemptDraft.Explanation,SourceAnswer=attemptDraft.Answer,SourceSteps=attemptDraft.UseSolutionLogic?attemptDraft.Steps:[]};
                        return await qualityReviewer.ReviewTextAsync(generated,attemptDraft,output.Provider,output.Provider=="deepseek"?"https://api.deepseek.com":LocalGemmaGenerator.ConfiguredEndpoint,output.Provider=="deepseek"?DeepSeekVisualGenerator.Model:generated.RuntimeModelId,deepseekKey,progress,job.Cancel.Token);
                    }
                    output.Result=await GenerateReviewed(currentDraft);
                    if(output.Result.Quality?.State=="fail"){
                        var failures=string.Join(" | ",output.Result.Quality.Checks.Where(c=>c.State=="fail").Select(c=>c.Label+": "+c.Evidence));
                        progress.Report("문제 검사 오류 · 같은 풀이 단계로 자동 재작성 1/1");
                        var retryDraft=currentDraft with{Id=Guid.NewGuid(),LogicScope=currentDraft.LogicScope+"\n[이전 초안 검사 실패] "+failures+"\n위 오류를 피하되 suppliedSteps의 판단 과정은 그대로 유지해 처음부터 새 문제를 작성한다."};
                        output.Result=await GenerateReviewed(retryDraft);
                    }
                    if(output.Result.Quality?.State=="fail"){
                        var failures=string.Join(" | ",output.Result.Quality.Checks.Where(c=>c.State=="fail").Select(c=>c.Label+": "+c.Evidence));
                        throw new InvalidDataException("생성 문제의 조건·수치·해설 검사를 통과하지 못했습니다. 잘못된 문제는 완료로 표시하지 않습니다. "+failures);
                    }
                    if(output.Result.Quality?.AnswerVerified!=true)
                        throw new InvalidDataException("정답을 독립 계산과 문항 검토로 확인하지 못했습니다. 미검증 문제와 정답은 완료 결과로 표시하지 않습니다.");
                    output.Result=output.Result with{QualityJobId=id};
                    output.State="ready";output.Phase="완료";
                }catch(OperationCanceledException){output.State=job.UserCancelled?"cancelled":"failed";output.Error=job.UserCancelled?"생성을 취소했습니다.":"생성 시간이 초과됐습니다.";}
                catch(Exception e)when(e is ArgumentException or InvalidDataException or InvalidOperationException or UnsupportedProblemException){output.State="failed";output.Result=null;output.Error=e.Message;app.Logger.LogWarning("Generation validation failed: job={JobId}, provider={Provider}, formatStage={FormatStage}, exceptionType={ExceptionType}, innerExceptionType={InnerExceptionType}",id,output.Provider,e.Data["DeepSeekFormatStage"]??"validation",e.GetType().Name,e.InnerException?.GetType().Name??"none");}
                catch(HttpRequestException){output.State="failed";output.Error="모델 서버에 연결하지 못했습니다.";}
                catch(Exception e){output.State="failed";output.Error="모델 생성 처리에 실패했습니다.";app.Logger.LogError("Generation unexpected error: job={JobId}, provider={Provider}, exceptionType={ExceptionType}",id,output.Provider,e.GetType().Name);}
                finally{if(output.State=="failed")app.Logger.LogWarning("Generation failed: job={JobId}, provider={Provider}, phase={Phase}, error={Error}",id,output.Provider,output.Phase,output.Error);}
            }
            if(input.StageSeries){
                for(var index=0;index<job.Outputs.Length;index++)await GenerateOne(job.Outputs[index],learningStages[index].Draft);
            }else await Task.WhenAll(job.Outputs.Select(output=>GenerateOne(output,draft)));
            job.Result=input.StageSeries?job.Outputs.LastOrDefault(o=>o.State=="ready")?.Result:job.Outputs.FirstOrDefault(o=>o.State=="ready")?.Result;
            var allReady=job.Outputs.All(o=>o.State=="ready");
            job.State=allReady?"ready":job.UserCancelled?"cancelled":"failed";
            if(!allReady)job.Error=string.Join(" · ",job.Outputs.Where(o=>o.State!="ready").Select(o=>(o.StageLabel.Length>0?o.StageLabel:o.Provider)+": "+(o.Error.Length>0?o.Error:o.Phase)));
        }
        catch(OperationCanceledException){job.State=job.UserCancelled?"cancelled":"failed";job.Error=job.UserCancelled?"생성을 취소했습니다. 입력은 유지됩니다.":"생성 시간이 초과됐습니다. 입력은 유지됩니다. 한 문제만 남겨 다시 생성해 주세요.";}
        catch(Exception e) when(e is ArgumentException or InvalidDataException or InvalidOperationException or IOException or UnsupportedProblemException){job.State="failed";job.Error=e.Message;}
        catch(HttpRequestException){job.State="failed";job.Error="로컬 Gemma 서버에 연결하지 못했습니다.";}
        catch(Exception){job.State="failed";job.Error="생성 처리에 실패했습니다. 입력은 유지됩니다.";}
        finally{job.Finished=true;try{await resultCache.SaveAsync(id,job);}catch(Exception e)when(e is IOException or JsonException or UnauthorizedAccessException){app.Logger.LogWarning("Job result cache failed: job={JobId}, exceptionType={ExceptionType}",id,e.GetType().Name);}finally{gate.Release();}}
    });
    return Results.Ok(new{id,stageSeries=input.StageSeries,stageCount=input.StageSeries?learningStages.Length:0});
});
app.MapGet("/api/jobs/{id}",(string id,HttpContext context)=>jobs.TryGetValue(id,out var j)?Results.Ok(new{state=j.State,phase=j.Phase,stageSeries=j.Outputs.Any(o=>o.StageCount>0),stageCount=j.Outputs.Max(o=>o.StageCount),elapsedSeconds=(int)(DateTime.UtcNow-j.Created).TotalSeconds,error=j.Error,result=RendererCompatibility.ForClient(j.Result,context.Request.Headers["X-EduMaster-Renderer"].ToString()),outputs=j.Outputs.Select(o=>new{provider=o.Provider,model=o.Model,stageNumber=o.StageNumber,stageCount=o.StageCount,stageLabel=o.StageLabel,state=o.State,phase=o.Phase,error=o.Error,result=RendererCompatibility.ForClient(o.Result,context.Request.Headers["X-EduMaster-Renderer"].ToString())})}):Results.NotFound());
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
        await resultCache.SaveAsync(id,job,context.RequestAborted);
        return Results.Ok(report);
    }catch(ArgumentException e){return Results.BadRequest(new{error=e.Message});}
    catch(IOException){return Results.Json(new{error="검사 기록을 보관하지 못했습니다. 같은 작업을 다시 확인해 주세요."},statusCode:503);}
    finally{job.ReviewGate.Release();}
});
_=Task.Run(async()=>{using var timer=new PeriodicTimer(TimeSpan.FromMinutes(1));try{while(await timer.WaitForNextTickAsync(app.Lifetime.ApplicationStopping)){foreach(var old in sources.Where(x=>DateTime.UtcNow-x.Value.Created>TimeSpan.FromHours(2)).ToArray()){sources.TryRemove(old.Key,out _);sourceCache.Remove(old.Key);}foreach(var old in jobs.Where(x=>x.Value.Finished&&DateTime.UtcNow-x.Value.Created>GenerationResultCache.Retention).ToArray()){if(jobs.TryRemove(old.Key,out var removed)){removed.Cancel.Dispose();resultCache.Remove(old.Key);}}}}catch(OperationCanceledException){}});
app.Run();

record GenerationInput(string? Title,string? Body,string? Answer,string? Explanation,string? SourceId=null,bool RequiresImage=false,bool FromSolution=false,string Provider="gemma",string? RequestId=null,bool UseSolutionLogic=false,string[]? LogicSteps=null,bool StageSeries=false,int? ExpectedStageCount=null);
record ReportSaveInput(string? Title,string? Html);
record SolutionInput(string? Title,string? Body,string Provider="deepseek",string? SourceId=null);
record RenderReviewInput(Guid ResultId,string Png,bool IncludeAnswer=false);
record TextReviewInput(Guid ResultId);

sealed class ImmediateProgress(Action<string> action):IProgress<string>{public void Report(string value)=>action(value);}
