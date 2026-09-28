using System.Text.RegularExpressions;

namespace EduMaster.Core;

// Independent arithmetic for the XY2/YZ4 and XY2/X2Z4 gas-mixture family.
// All ratios and masses come from the generated question; no fixture numbers are embedded.
public static class GasMixtureAtomCheck
{
    private static readonly Regex Row=new(@"\|\s*\((?<v>[가나])\)\s*\|\s*(?<g>[^|]+)\|\s*(?<m>\d+)w\s*\|\s*(?<xz>\d+\s*/\s*\d+)\s*\|\s*(?<u>\d+)\s*\|",RegexOptions.Compiled);
    private static readonly Regex Claimed=new(@"(?<s>[ㄱㄴㄷ])\s*\.\s*[^\r\n]*?=\s*(?<v>\d+\s*/\s*\d+)",RegexOptions.Compiled);
    private static readonly double Epsilon=1e-7;

    // The image reader can copy the final answer correctly while misreading a
    // worked intermediate value. Rebuild this recognized source family from
    // the printed table before its steps become the generation template.
    public static ProblemSolutionMaterial? VerifySource(ProblemSolutionMaterial material)
    {
        var body=material.Body.Replace('₂','2').Replace('₄','4');
        var rows=Row.Matches(body).Cast<Match>().ToDictionary(m=>m.Groups["v"].Value);
        if(!rows.TryGetValue("가",out var ga)||!rows.TryGetValue("나",out var na))return null;
        if(!Regex.IsMatch(ga.Groups["g"].Value,@"^\s*XY2\s*,\s*YZ4\s*$")||!Regex.IsMatch(na.Groups["g"].Value,@"^\s*XY2\s*,\s*X2Z4\s*$"))return null;
        var massRatio=Regex.Match(body,@"\(나\)에서\s*X의\s*질량\s*/\s*Y의\s*질량\s*=\s*(?<v>\d+\s*/\s*\d+)");
        if(!massRatio.Success||Claimed.Matches(body).Count!=3)return null;
        var check=Inspect(new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"source","기준 문제",material.Body,["ㄱ","ㄴ","ㄷ","ㄱ, ㄴ","ㄴ, ㄷ"],material.Answer,$"{ga.Groups["m"].Value}w / {na.Groups["m"].Value}w 전체 질량을 비교한다.",["비율 검산"],"기준 검산"));
        if(check?.State!="pass")throw new InvalidDataException("기준 문제의 화학식·표·정답을 독립 계산한 결과가 맞지 않습니다. "+(check?.Evidence??"원본 표를 읽지 못했습니다."));
        static double Ratio(string value){var parts=value.Split('/');return double.Parse(parts[0].Trim(),System.Globalization.CultureInfo.InvariantCulture)/double.Parse(parts[1].Trim(),System.Globalization.CultureInfo.InvariantCulture);}
        static double Number(string value)=>double.Parse(value,System.Globalization.CultureInfo.InvariantCulture);
        static string Fraction(double value){for(var denominator=1;denominator<=1000;denominator++){var numerator=Math.Round(value*denominator);if(Math.Abs(numerator/denominator-value)<Epsilon)return denominator==1?numerator.ToString(System.Globalization.CultureInfo.InvariantCulture):$"{numerator:g}/{denominator}";}return value.ToString("g6",System.Globalization.CultureInfo.InvariantCulture);}
        static string TimesK(string fraction)=>fraction.Contains('/')?$"({fraction})k":fraction+"k";
        var b=1/(4*Ratio(na.Groups["xz"].Value)-2);var d=1/(4*Ratio(ga.Groups["xz"].Value));
        var y=(1+2*b)/(2*Ratio(massRatio.Groups["v"].Value));
        var gaY=2+d;var unit=Number(ga.Groups["u"].Value)/Number(na.Groups["u"].Value);
        var gaBase=1+2*y+d*y;var naBase=1+2*y+2*b;
        var z=(gaY*naBase-2*unit*gaBase)/(2*unit*4*d-gaY*4*b);
        var c=Number(ga.Groups["m"].Value)/Number(na.Groups["m"].Value)*(naBase+4*b*z)/(gaBase+4*d*z);
        var scale=Enumerable.Range(1,1000).FirstOrDefault(n=>Math.Abs(y*n-Math.Round(y*n))<Epsilon);
        if(scale==0)scale=1;
        var xScaled=Fraction(scale);var yScaled=Fraction(y*scale);var zScaled=Fraction(z*scale);
        var trueLabels=Regex.Replace(material.Answer,@"^[①②③④⑤]\s*","").Trim();
        var steps=new[]{
            $"(나)의 XY2를 a몰, X2Z4를 b몰로 두고 X/Z 원자 수 비와 X/Y 질량비를 계산하면 b/a={Fraction(b)}, x:y={xScaled}:{yScaled}이다.",
            $"(가)의 XY2를 c몰, YZ4를 d몰로 둔다. YZ4는 Y가 1개, Z가 4개이다. X/Z 원자 수 비로 d/c={Fraction(d)}, 단위 질량당 Y 원자 수 비 {ga.Groups["u"].Value}:{na.Groups["u"].Value}와 두 용기의 전체 질량 {ga.Groups["m"].Value}w:{na.Groups["m"].Value}w로 c/a={Fraction(c)}, x={TimesK(xScaled)}, y={TimesK(yScaled)}, z={TimesK(zScaled)}를 구한다.",
            $"(가)의 X/Y 질량비, (나)/(가)의 전체 분자 수 비, x/(y+z)를 각각 다시 계산하여 ㄱ·ㄴ·ㄷ의 참거짓을 판정한다. 옳은 것은 {trueLabels}이고 정답은 {material.Answer}이다."
        };
        return material with{Explanation=string.Join("\n",steps),Steps=steps,Uncertainties=material.Uncertainties.Concat(["이 화학식 유형은 이미지 분석의 중간 수치와 STEP을 표의 원자 수·질량으로 독립 재계산했습니다."]).Distinct().ToArray()};
    }

    public static QualityCheck? Inspect(SampleResult result)
    {
        var body=result.Body.Replace('₂','2').Replace('₄','4');
        var rows=Row.Matches(body).Cast<Match>().ToDictionary(m=>m.Groups["v"].Value);
        if(!rows.TryGetValue("가",out var ga)||!rows.TryGetValue("나",out var na))return null;
        if(!Regex.IsMatch(ga.Groups["g"].Value,@"^\s*XY2\s*,\s*YZ4\s*$")||!Regex.IsMatch(na.Groups["g"].Value,@"^\s*XY2\s*,\s*X2Z4\s*$"))return null;
        var massRatio=Regex.Match(body,@"\(나\)에서\s*X의\s*질량\s*/\s*Y의\s*질량\s*=\s*(?<v>\d+\s*/\s*\d+)");
        if(!massRatio.Success)return null;
        static QualityCheck Fail(string reason)=>new("calculation","독립 수치 검산","fail",reason,"code-gas-mixture");
        try
        {
            static double Ratio(string value){var parts=value.Split('/');return double.Parse(parts[0].Trim(),System.Globalization.CultureInfo.InvariantCulture)/double.Parse(parts[1].Trim(),System.Globalization.CultureInfo.InvariantCulture);}
            static double Number(string value)=>double.Parse(value,System.Globalization.CultureInfo.InvariantCulture);
            var gaXZ=Ratio(ga.Groups["xz"].Value);var naXZ=Ratio(na.Groups["xz"].Value);
            var gaMass=Number(ga.Groups["m"].Value);var naMass=Number(na.Groups["m"].Value);
            var gaUnit=Number(ga.Groups["u"].Value);var naUnit=Number(na.Groups["u"].Value);
            if(gaXZ<=0||naXZ<=0||gaMass<=0||naMass<=0||gaUnit<=0||naUnit<=0)return Fail("표의 질량·원자 수 비·상댓값은 모두 양수여야 합니다.");
            // Set a=1 and x=1. b/a and d/c follow from X/Z atom-count ratios.
            var bOverA=1/(4*naXZ-2);var dOverC=1/(4*gaXZ);
            if(!double.IsFinite(bOverA)||!double.IsFinite(dOverC)||bOverA<=0||dOverC<=0)return Fail("X/Z 원자 수 비가 양의 기체 몰수와 양립하지 않습니다.");
            var y=(1+2*bOverA)/(2*Ratio(massRatio.Groups["v"].Value));
            var gaBase=1+2*y+dOverC*y;var gaZ=4*dOverC;
            var naBase=1+2*y+2*bOverA;var naZ=4*bOverA;
            var unitRatio=gaUnit/naUnit;var gaY=2+dOverC;
            var denominator=2*unitRatio*gaZ-gaY*naZ;
            if(Math.Abs(denominator)<Epsilon)return Fail("단위 질량당 Y 원자 수 비로 Z의 원자량이 유일하게 정해지지 않습니다.");
            var z=(gaY*naBase-2*unitRatio*gaBase)/denominator;
            if(!double.IsFinite(y)||!double.IsFinite(z)||y<=0||z<=0)return Fail("표의 비율을 화학식의 원자 수로 계산하면 양의 원자량이 나오지 않아 문제가 성립하지 않습니다. YZ4는 Y 원자 1개와 Z 원자 4개이고, XY2는 Y 원자 2개입니다. 이 원자 수로 표의 상댓값·전체 질량을 다시 설계하세요.");
            var gaPerC=gaBase+gaZ*z;var naPerA=naBase+naZ*z;
            var cOverA=(gaMass/naMass)*(naPerA/gaPerC);
            if(!double.IsFinite(cOverA)||cOverA<=0)return Fail("표의 전체 질량비가 양의 기체 몰수와 양립하지 않습니다.");
            var statements=Claimed.Matches(body).Cast<Match>().ToDictionary(m=>m.Groups["s"].Value,m=>Ratio(m.Groups["v"].Value));
            if(statements.Count==3){
                var actual=new Dictionary<string,double>{{"ㄱ",1/(gaY*y)},{"ㄴ",(1+bOverA)/(cOverA*(1+dOverC))},{"ㄷ",1/(y+z)}};
                var trueLabels=string.Join(", ",new[]{"ㄱ","ㄴ","ㄷ"}.Where(label=>Math.Abs(actual[label]-statements[label])<Epsilon));
                var answer=Regex.Replace(result.Answer,@"^[①②③④⑤]\s*","").Trim();
                if(answer!=trueLabels)return Fail($"표를 독립 계산한 참인 진술은 '{trueLabels}'인데 표시된 정답은 '{answer}'입니다.");
                // A cross-container molecule ratio cannot be obtained without the two total masses.
                if(!Regex.IsMatch(result.Explanation,@"(?<![A-Za-z0-9])"+gaMass.ToString(System.Globalization.CultureInfo.InvariantCulture)+@"\s*w(?![A-Za-z0-9])")||!Regex.IsMatch(result.Explanation,@"(?<![A-Za-z0-9])"+naMass.ToString(System.Globalization.CultureInfo.InvariantCulture)+@"\s*w(?![A-Za-z0-9])"))
                    return Fail($"전체 분자 수 비를 구하려면 표의 전체 질량 {gaMass:g}w와 {naMass:g}w로 두 용기의 몰수 비를 계산하는 과정을 해설에 써야 합니다.");
            }else if(body.Contains("Z의 원자량은 Y의 원자량의 몇 배")){
                var answer=Regex.Match(result.Answer,@"(?<v>\d+\s*/\s*\d+)");
                if(!answer.Success||Math.Abs(Ratio(answer.Groups["v"].Value)-z/y)>Epsilon)return Fail($"표를 독립 계산한 Z/Y 원자량비는 {z/y:g6}인데 표시된 정답과 다릅니다.");
            }
            return new("calculation","독립 수치 검산","pass","XY2·YZ4·X2Z4의 원자 수, 전체 질량, 단위 질량당 Y 원자 수 비와 정답을 코드로 검산했습니다.","code-gas-mixture");
        }
        catch(Exception e)when(e is FormatException or OverflowException or ArgumentException){return Fail("표의 숫자나 비율을 독립 계산기로 읽지 못했습니다: "+e.Message);}
    }
}
