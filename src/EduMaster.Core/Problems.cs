using System.Security.Cryptography;
using System.Text;

namespace EduMaster.Core;

public sealed record ProblemDraft
{
    public const int MinLogicSteps = 1;
    public const int MaxLogicSteps = 6;
    public Guid Id { get; init; } = Guid.NewGuid();
    public string Title { get; init; } = "";
    public string Body { get; init; } = "";
    public string Answer { get; init; } = "";
    public string Explanation { get; init; } = "";
    public bool FromSolution { get; init; }
    public bool UseSolutionLogic { get; init; }
    public string[] Steps { get; init; } = [];
    public string[] ExcludedSteps { get; init; } = [];
    public string LogicScope { get; init; } = "";
    public bool SkipDeterministicPlan { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public ImportedSource? Source { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? ReadMethod { get; init; }

    public void Validate()
    {
        if (Id == Guid.Empty || Body is null || Answer is null || Explanation is null || string.IsNullOrWhiteSpace(Title) || (string.IsNullOrWhiteSpace(Body) && Source is null)
            || Steps is null || ExcludedSteps is null || Steps.Length > MaxLogicSteps || ExcludedSteps.Length > MaxLogicSteps || Steps.Any(s => s is null) || ExcludedSteps.Any(s => s is null))
            throw new ArgumentException("문제 제목과 본문을 입력하거나 샘플 파일을 선택해 주세요. 정답·해설은 선택 사항입니다.");
        if(UseSolutionLogic&&string.IsNullOrWhiteSpace(Explanation))throw new ArgumentException("문제+풀이 방식에서는 기준 풀이가 필요합니다. 풀이가 함께 보이는 이미지를 넣거나 기준 해설을 입력해 주세요.");
        if(UseSolutionLogic&&(Steps.Length<MinLogicSteps||Steps.Length>MaxLogicSteps||Steps.Any(string.IsNullOrWhiteSpace)))throw new ArgumentException($"문제+풀이 방식에서는 실제 풀이 순서대로 {MinLogicSteps}~{MaxLogicSteps}개의 풀이 단계가 필요합니다. 풀이가 없으면 먼저 STEP별 풀이를 생성해 주세요.");
        if(UseSolutionLogic&&Body.Contains("[판독불가]"))throw new ArgumentException("기준 문제에 판독불가 부분이 있습니다. 원본을 보고 해당 글자·수치를 수정한 뒤 생성해 주세요.");
        if (Body.Length > 12000 || Explanation.Length > 12000 || Answer.Length > 3000 || Title.Length > 200 || LogicScope.Length>1000 || Steps.Any(s => s.Length > 3000) || ExcludedSteps.Any(s => s.Length > 3000))
            throw new ArgumentException("입력 내용이 너무 깁니다. 문제·해설은 12,000자 이내로 입력해 주세요.");
    }

    public string Fingerprint() => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        System.Text.Json.JsonSerializer.Serialize(this))));
}

public sealed record SampleResult(Guid Id, Guid InputId, string InputFingerprint, string Title,
    string Body, string[] Choices, string Answer, string Explanation, string[] Steps, string ChangeSummary)
{
    public const string Notice = "샘플 시연 · 실제 AI 호출 없음 · 화학 검증 전";
    public string GenerationNotice { get; init; } = Notice;
    public string SourceProblem { get; init; } = "";
    public string SourceExplanation { get; init; } = "";
    public string SourceAnswer { get; init; } = "";
    public string[] SourceSteps { get; init; } = [];
    public string Model { get; init; } = "";
    public string RuntimeModelId { get; init; } = "";
    public string PromptVersion { get; init; } = "";
    public string UsageSummary { get; init; } = "";
    public PreservedFigure[] Figures { get; init; } = [];
    public VisualUnderstanding[] VisualContexts { get; init; } = [];
    public string VisualVerification { get; init; } = "";
    public int ImageInputCount { get; init; }
    public ProblemGraph? Graph { get; init; }
    public ChargeDiagram[] Diagrams { get; init; } = [];
    public ProblemDrawing[] Drawings {get;init;}=[];
    public bool RequiresVisuals {get;init;}
    public QualityReport? Quality {get;init;}
    public string? QualityJobId {get;init;}
    public BeakerTemplate[] VisualTemplates {get;init;}=[];
}

public sealed record DrawingElement(string Type,double[] Coordinates,string Text,double FontSize,bool Dashed,string Fill="white");
public sealed record ProblemDrawing(string Title,double Width,double Height,string Description,DrawingElement[] Elements);

public sealed record DiagramCharge(string Name,double Position,string Sign,string ForceDirection);
public sealed record ChargeDiagram(string Title,string Unit,DiagramCharge[] Charges);

public sealed record ProblemGraph(
    string Type,
    string Title,
    string XLabel,
    string YLabel,
    double[] XPoints,
    double[] YPoints,
    string[]? Annotations = null
);

public static class SampleProblems
{
    public static ProblemDraft Nitrogen() => new()
    {
        Title = "한계 반응물과 암모니아 생성량",
        Body = "반응식 N₂ + 3H₂ → 2NH₃에 따라 질소 2 mol과 수소 3 mol을 충분한 시간 동안 반응시킨다. 생성되는 암모니아의 최대 몰수는?",
        Answer = "2 mol",
        Explanation = "질소 2 mol에는 수소 6 mol이 필요하다. 수소는 3 mol이므로 한계 반응물이다. 수소 3 mol로 암모니아 2 mol이 생성된다.",
        Steps = ["반응식의 계수비 N₂ : H₂ : NH₃ = 1 : 3 : 2 확인", "수소가 한계 반응물인지 비교", "수소 몰수 × 2/3으로 암모니아 몰수 계산"]
    };

    public static ProblemDraft Magnesium() => new()
    {
        Title = "마그네슘 연소와 생성물 질량",
        Body = "반응식 2Mg + O₂ → 2MgO에 따라 마그네슘 24 g과 산소 32 g을 충분한 시간 동안 반응시킨다. Mg = 24 g/mol, O₂ = 32 g/mol, MgO = 40 g/mol일 때 생성되는 MgO의 최대 질량은?",
        Answer = "40 g",
        Explanation = "Mg와 O₂는 각각 1 mol이다. Mg 1 mol에는 O₂ 0.5 mol이 필요하므로 Mg가 한계 반응물이다. MgO 1 mol, 즉 40 g이 생성된다.",
        Steps = ["질량을 몰수로 변환", "계수비로 한계 반응물 확인", "MgO 몰수에 몰질량 40 g/mol을 곱하기"]
    };

    public static SampleResult Generate(ProblemDraft draft, int variation)
    {
        draft.Validate();
        var compact = static (string s) => string.Concat(s.Where(c => !char.IsWhiteSpace(c)));
        var nitrogen = compact(draft.Body) == compact(Nitrogen().Body);
        var magnesium = compact(draft.Body) == compact(Magnesium().Body);
        if (!nitrogen && !magnesium)
            throw new ArgumentException("샘플 모드 시연은 준비된 예시 2개만 사용합니다. 내 파일·자유 입력의 변형은 ‘변형 문제 생성’을 눌러 주세요.");
        var scale = variation % 2 == 0 ? 2 : 3;
        if (nitrogen)
        {
            var n = 2 * scale;
            var h = 3 * scale;
            var answer = h / 3 * 2;
            return new(Guid.NewGuid(), draft.Id, draft.Fingerprint(), draft.Title + " · 샘플 변형",
                $"반응식 N₂ + 3H₂ → 2NH₃에 따라 질소 {n} mol과 수소 {h} mol을 충분한 시간 동안 반응시킨다. 생성되는 암모니아의 최대 몰수는?",
                [$"{scale} mol", $"{3 * scale} mol", $"{answer} mol", $"{4 * scale} mol", $"{6 * scale} mol"],
                $"③ {answer} mol",
                $"질소 {n} mol을 모두 반응시키려면 수소 {3 * n} mol이 필요합니다. 주어진 수소는 {h} mol이므로 수소가 한계 반응물입니다.\n생성 NH₃ = {h} × 2/3 = {answer} mol입니다. 질소는 {scale} mol 남습니다.",
                ["계수비 1 : 3 : 2 확인", $"수소 필요량 {3 * n} mol > 주어진 {h} mol", $"NH₃ 생성량 {h} × 2/3 = {answer} mol"],
                $"질소 2 → {n} mol · 수소 3 → {h} mol · 풀이 구조 유지")
            {
                Graph = new ProblemGraph("line", "첨가한 H₂에 따른 NH₃ 생성량", "첨가한 H₂의 양 (mol)", "생성된 NH₃의 양 (mol)", [0, h / 2.0, h, h * 1.5], [0, answer / 2.0, answer, answer], [$"반응 완결점 ({h} mol, {answer} mol)"])
            };
        }
        var mass = 40 * scale;
        return new(Guid.NewGuid(), draft.Id, draft.Fingerprint(), draft.Title + " · 샘플 변형",
            $"반응식 2Mg + O₂ → 2MgO에 따라 마그네슘 {24 * scale} g과 산소 {32 * scale} g을 충분한 시간 동안 반응시킨다. Mg = 24 g/mol, O₂ = 32 g/mol, MgO = 40 g/mol일 때 생성되는 MgO의 최대 질량은?",
            [$"{20 * scale} g", $"{30 * scale} g", $"{mass} g", $"{50 * scale} g", $"{60 * scale} g"], $"③ {mass} g",
            $"Mg = {24 * scale}/24 = {scale} mol, O₂ = {32 * scale}/32 = {scale} mol입니다.\nMg {scale} mol에는 산소 {scale / 2.0} mol만 필요하므로 Mg가 한계 반응물입니다. MgO는 {scale} mol 생성되며 질량은 {scale} × 40 = {mass} g입니다.",
            [$"질량을 몰수로 변환: 각각 {scale} mol", "Mg : O₂ = 2 : 1로 한계 반응물 비교", $"MgO 질량 {scale} × 40 = {mass} g"],
            $"Mg 24 → {24 * scale} g · O₂ 32 → {32 * scale} g · 풀이 구조 유지")
        {
            Graph = new ProblemGraph("line", "반응한 O₂ 질량에 따른 MgO 생성 질량", "반응한 O₂의 질량 (g)", "생성된 MgO의 질량 (g)", [0, 16 * scale, 32 * scale, 48 * scale], [0, 20 * scale, mass, mass], [$"반응 완결점 ({32 * scale} g, {mass} g)"])
        };
    }
}
